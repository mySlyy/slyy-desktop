//! Perimeter checks on the WebSocket upgrade request, before any byte
//! reaches pi-host. Pure functions over the parsed request head so every
//! refusal path is unit-testable without sockets.

use super::config::{
    GatewayConfig, RACP_DEVICE_TOKEN_PREFIX, RACP_PAIRING_TOKEN_PREFIX, RACP_WS_PATH,
    RACP_WS_SUBPROTOCOL,
};

pub const MAX_HEAD_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 48;
const MAX_TOKEN_BYTES: usize = 256;

/// The parts of the upgrade request the gateway acts on. Everything else
/// (cookies, Origin, forwarding headers) is dropped and never relayed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upgrade {
    pub authorization: String,
    pub websocket_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Health,
    Upgrade(Upgrade),
    Refuse(Refusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    BadRequest,
    /// Counted by the auth throttle: a missing, malformed or URL-borne credential.
    Unauthorized,
    Forbidden,
    NotFound,
    Misdirected,
}

impl Refusal {
    pub fn counts_as_auth_failure(self) -> bool {
        matches!(self, Refusal::Unauthorized)
    }
}

/// Returns `None` while the head is incomplete, or the decision once the
/// blank line arrived. `consumed` is the head length; a client that sends
/// bytes past it before the 101 is refused.
pub fn inspect(buffer: &[u8], config: &GatewayConfig) -> Option<(Decision, usize)> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(buffer) {
        Ok(httparse::Status::Complete(consumed)) => Some((decide(&request, config), consumed)),
        Ok(httparse::Status::Partial) => None,
        Err(_) => Some((Decision::Refuse(Refusal::BadRequest), buffer.len())),
    }
}

fn header<'a>(request: &'a httparse::Request<'_, '_>, name: &str) -> Option<&'a str> {
    let mut found = None;
    for h in request.headers.iter() {
        if h.name.eq_ignore_ascii_case(name) {
            if found.is_some() {
                // A repeated security header is ambiguous; treat as malformed.
                return Some("\u{0}");
            }
            found = std::str::from_utf8(h.value).ok().map(str::trim);
        }
    }
    found
}

fn has_token(value: Option<&str>, token: &str) -> bool {
    value.is_some_and(|v| {
        v.split(',')
            .any(|part| part.trim().eq_ignore_ascii_case(token))
    })
}

fn decide(request: &httparse::Request<'_, '_>, config: &GatewayConfig) -> Decision {
    use Decision::Refuse;
    if request.method != Some("GET") {
        return Refuse(Refusal::BadRequest);
    }
    let target = request.path.unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path == "/healthz" {
        return Decision::Health;
    }
    if path != RACP_WS_PATH {
        return Refuse(Refusal::NotFound);
    }
    // Security §3.1: a credential in the URL is never accepted, even a valid one.
    let lowered = query.to_ascii_lowercase();
    if lowered.contains("token") || lowered.contains("auth") {
        return Refuse(Refusal::Unauthorized);
    }
    if let Some(origin) = header(request, "origin") {
        if !config
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
        {
            return Refuse(Refusal::Forbidden);
        }
    }
    if let Some(expected) = &config.public_host {
        let host = header(request, "host").unwrap_or_default();
        let name = host.rsplit_once(':').map_or(host, |(name, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                name
            } else {
                host
            }
        });
        if !name.eq_ignore_ascii_case(expected) {
            return Refuse(Refusal::Misdirected);
        }
    }
    let upgrade_ok = has_token(header(request, "upgrade"), "websocket")
        && has_token(header(request, "connection"), "upgrade")
        && header(request, "sec-websocket-version") == Some("13")
        && has_token(
            header(request, "sec-websocket-protocol"),
            RACP_WS_SUBPROTOCOL,
        );
    let key = header(request, "sec-websocket-key").filter(|k| k.len() == 24);
    let (true, Some(key)) = (upgrade_ok, key) else {
        return Refuse(Refusal::BadRequest);
    };
    let Some(token) = header(request, "authorization").and_then(bearer) else {
        return Refuse(Refusal::Unauthorized);
    };
    let shaped = token.len() <= MAX_TOKEN_BYTES
        && (token.starts_with(RACP_DEVICE_TOKEN_PREFIX)
            || token.starts_with(RACP_PAIRING_TOKEN_PREFIX))
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if !shaped {
        return Refuse(Refusal::Unauthorized);
    }
    Decision::Upgrade(Upgrade {
        authorization: format!("Bearer {token}"),
        websocket_key: key.to_string(),
    })
}

fn bearer(value: &str) -> Option<&str> {
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(' '))
        .then_some(token)
}

pub fn status_line(status: u16) -> &'static str {
    match status {
        200 => "200 OK",
        400 => "400 Bad Request",
        401 => "401 Unauthorized",
        403 => "403 Forbidden",
        404 => "404 Not Found",
        421 => "421 Misdirected Request",
        429 => "429 Too Many Requests",
        502 => "502 Bad Gateway",
        503 => "503 Service Unavailable",
        _ => "500 Internal Server Error",
    }
}

pub fn refusal_status(refusal: Refusal) -> u16 {
    match refusal {
        Refusal::BadRequest => 400,
        Refusal::Unauthorized => 401,
        Refusal::Forbidden => 403,
        Refusal::NotFound => 404,
        Refusal::Misdirected => 421,
    }
}

/// A minimal response that closes the connection; never echoes request data.
pub fn plain_response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status_line(status),
        body.len(),
        body
    )
}

pub fn switching_protocols(websocket_key: &str) -> String {
    let accept =
        tokio_tungstenite::tungstenite::handshake::derive_accept_key(websocket_key.as_bytes());
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: {RACP_WS_SUBPROTOCOL}\r\n\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> GatewayConfig {
        let args: Vec<String> = [
            "--listen",
            "127.0.0.1:0",
            "--upstream",
            "ws://127.0.0.1:9",
            "--public-host",
            "anna.wapsol.slyy.ai",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        GatewayConfig::parse(&args).expect("config")
    }

    fn request(path: &str, extra: &[&str]) -> Vec<u8> {
        let mut lines = vec![
            format!("GET {path} HTTP/1.1"),
            "Host: anna.wapsol.slyy.ai:443".into(),
            "Upgrade: websocket".into(),
            "Connection: keep-alive, Upgrade".into(),
            "Sec-WebSocket-Version: 13".into(),
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==".into(),
            format!("Sec-WebSocket-Protocol: {RACP_WS_SUBPROTOCOL}"),
        ];
        lines.extend(extra.iter().map(|s| s.to_string()));
        format!("{}\r\n\r\n", lines.join("\r\n")).into_bytes()
    }

    fn decide_on(bytes: &[u8]) -> Decision {
        inspect(bytes, &config()).expect("complete head").0
    }

    #[test]
    fn valid_device_upgrade_passes_with_only_the_credential() {
        let decision = decide_on(&request(
            RACP_WS_PATH,
            &["Authorization: Bearer pdt1.abc_DEF-123", "Cookie: x=1"],
        ));
        assert_eq!(
            decision,
            Decision::Upgrade(Upgrade {
                authorization: "Bearer pdt1.abc_DEF-123".into(),
                websocket_key: "dGhlIHNhbXBsZSBub25jZQ==".into(),
            })
        );
    }

    #[test]
    fn refusals_cover_each_perimeter_rule() {
        let auth = "Authorization: Bearer ppt1.pairing";
        let cases: Vec<(Vec<u8>, Decision)> = vec![
            (
                request("/other", &[auth]),
                Decision::Refuse(Refusal::NotFound),
            ),
            (
                request("/v1/racp/ws?token=pdt1.x", &[auth]),
                Decision::Refuse(Refusal::Unauthorized),
            ),
            (
                request(RACP_WS_PATH, &[]),
                Decision::Refuse(Refusal::Unauthorized),
            ),
            (
                request(RACP_WS_PATH, &["Authorization: Bearer sk-live-123"]),
                Decision::Refuse(Refusal::Unauthorized),
            ),
            (
                request(RACP_WS_PATH, &["Authorization: Basic cGRUMTo="]),
                Decision::Refuse(Refusal::Unauthorized),
            ),
            (
                request(RACP_WS_PATH, &[auth, "Origin: https://evil.example"]),
                Decision::Refuse(Refusal::Forbidden),
            ),
            (
                request(RACP_WS_PATH, &[auth, auth]),
                Decision::Refuse(Refusal::Unauthorized),
            ),
            (request("/healthz", &[]), Decision::Health),
        ];
        for (bytes, expected) in cases {
            assert_eq!(
                decide_on(&bytes),
                expected,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    #[test]
    fn wrong_host_is_misdirected() {
        let bytes = request(RACP_WS_PATH, &["Authorization: Bearer pdt1.a"])
            .split(|b| *b == b'\n')
            .map(|line| {
                if line.starts_with(b"Host:") {
                    b"Host: bob.wapsol.slyy.ai\r".to_vec()
                } else {
                    line.to_vec()
                }
            })
            .collect::<Vec<_>>()
            .join(&b'\n');
        assert_eq!(decide_on(&bytes), Decision::Refuse(Refusal::Misdirected));
    }

    #[test]
    fn missing_subprotocol_is_bad_request() {
        let bytes = String::from_utf8(request(RACP_WS_PATH, &["Authorization: Bearer pdt1.a"]))
            .unwrap()
            .replace(RACP_WS_SUBPROTOCOL, "chat");
        assert_eq!(
            decide_on(bytes.as_bytes()),
            Decision::Refuse(Refusal::BadRequest)
        );
    }

    #[test]
    fn partial_head_waits_for_more() {
        assert!(inspect(b"GET /v1/racp/ws HTTP/1.1\r\nHost: a", &config()).is_none());
    }

    #[test]
    fn accept_key_matches_rfc_6455_example() {
        assert!(switching_protocols("dGhlIHNhbXBsZSBub25jZQ==")
            .contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    }
}
