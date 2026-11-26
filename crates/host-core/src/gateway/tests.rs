//! End-to-end gateway tests against a fake pi-host on loopback.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::{
    HeaderValue, AUTHORIZATION, ORIGIN, SEC_WEBSOCKET_PROTOCOL,
};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use super::config::{GatewayConfig, RACP_WS_SUBPROTOCOL};
use super::throttle::AuthThrottle;
use super::Gateway;

const GOOD_DEVICE: &str = "pdt1.good-device";

/// Accepts only `GOOD_DEVICE`, echoes text frames, and reports the header
/// names each accepted upgrade carried.
// The callback signature is fixed by tungstenite's server handshake API.
#[allow(clippy::result_large_err)]
async fn fake_pi_host() -> (u16, mpsc::UnboundedReceiver<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_tx, seen_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let seen_tx = seen_tx.clone();
            tokio::spawn(async move {
                let callback = |request: &Request,
                                mut response: Response|
                 -> Result<Response, ErrorResponse> {
                    let names = request
                        .headers()
                        .keys()
                        .map(|k| k.as_str().to_string())
                        .collect();
                    let auth = request
                        .headers()
                        .get(AUTHORIZATION)
                        .and_then(|v| v.to_str().ok());
                    if auth != Some(&format!("Bearer {GOOD_DEVICE}")) {
                        let mut refused = ErrorResponse::new(None);
                        *refused.status_mut() =
                            tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                        return Err(refused);
                    }
                    let _ = seen_tx.send(names);
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static(RACP_WS_SUBPROTOCOL),
                    );
                    Ok(response)
                };
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, callback).await else {
                    return;
                };
                while let Some(Ok(frame)) = ws.next().await {
                    match frame {
                        Message::Text(text) => {
                            let _ = ws.send(Message::Text(format!("echo:{text}").into())).await;
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            });
        }
    });
    (port, seen_rx)
}

fn config(upstream_port: u16) -> GatewayConfig {
    let args: Vec<String> = [
        "--listen",
        "127.0.0.1:0",
        "--upstream",
        &format!("ws://127.0.0.1:{upstream_port}"),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    GatewayConfig::parse(&args).unwrap()
}

async fn start(config: GatewayConfig, max_failures: u32) -> SocketAddr {
    let gateway = Gateway::bind_with_throttle(
        config,
        AuthThrottle::new(Duration::from_secs(60), max_failures),
    )
    .await
    .unwrap();
    let addr = gateway.local_addr();
    tokio::spawn(gateway.serve());
    addr
}

type Client = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn connect(
    addr: SocketAddr,
    token: Option<&str>,
    origin: Option<&str>,
) -> Result<Client, u16> {
    let mut request = format!("ws://{addr}/v1/racp/ws")
        .into_client_request()
        .unwrap();
    let headers = request.headers_mut();
    headers.insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(RACP_WS_SUBPROTOCOL),
    );
    if let Some(token) = token {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
    }
    if let Some(origin) = origin {
        headers.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    }
    let tcp = TcpStream::connect(addr).await.unwrap();
    match tokio_tungstenite::client_async(request, tcp).await {
        Ok((ws, _)) => Ok(ws),
        Err(WsError::Http(response)) => Err(response.status().as_u16()),
        Err(other) => panic!("unexpected handshake error {other}"),
    }
}

async fn next_text(ws: &mut Client) -> String {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Text(text))) => return text.to_string(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("expected text, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn relays_text_and_forwards_only_the_credential() {
    let (port, mut seen) = fake_pi_host().await;
    let addr = start(config(port), 10).await;
    let mut ws = connect(addr, Some(GOOD_DEVICE), None)
        .await
        .expect("upgrade");
    ws.send(Message::Text(
        r#"{"jsonrpc":"2.0","id":1,"method":"connection/ping"}"#.into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        next_text(&mut ws).await,
        r#"echo:{"jsonrpc":"2.0","id":1,"method":"connection/ping"}"#
    );
    let mut names = seen.recv().await.unwrap();
    names.sort();
    for name in &names {
        assert!(
            [
                "authorization",
                "connection",
                "host",
                "sec-websocket-key",
                "sec-websocket-protocol",
                "sec-websocket-version",
                "upgrade"
            ]
            .contains(&name.as_str()),
            "gateway leaked header {name}"
        );
    }
}

#[tokio::test]
async fn refused_credential_propagates_and_throttles() {
    let (port, _seen) = fake_pi_host().await;
    let addr = start(config(port), 2).await;
    assert_eq!(
        connect(addr, Some("pdt1.revoked"), None).await.err(),
        Some(401)
    );
    assert_eq!(connect(addr, None, None).await.err(), Some(401));
    // Two failures reached the limit; even a valid device is held back now.
    assert_eq!(
        connect(addr, Some(GOOD_DEVICE), None).await.err(),
        Some(429)
    );
}

#[tokio::test]
async fn browser_origin_is_refused_unless_allowed() {
    let (port, _seen) = fake_pi_host().await;
    let addr = start(config(port), 10).await;
    assert_eq!(
        connect(addr, Some(GOOD_DEVICE), Some("https://evil.example"))
            .await
            .err(),
        Some(403)
    );
    let mut allowed = config(port);
    allowed.allowed_origins.push("https://app.slyy.ai".into());
    let addr = start(allowed, 10).await;
    assert!(
        connect(addr, Some(GOOD_DEVICE), Some("https://app.slyy.ai"))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn binary_frame_closes_with_1003() {
    let (port, _seen) = fake_pi_host().await;
    let addr = start(config(port), 10).await;
    let mut ws = connect(addr, Some(GOOD_DEVICE), None).await.unwrap();
    ws.send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    match tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
    {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(frame.code, CloseCode::Unsupported),
        other => panic!("expected close, got {other:?}"),
    }
}

#[tokio::test]
async fn host_down_is_bad_gateway_and_health_stays_up() {
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let addr = start(config(port), 10).await;
    assert_eq!(
        connect(addr, Some(GOOD_DEVICE), None).await.err(),
        Some(502)
    );
    let mut raw = TcpStream::connect(addr).await.unwrap();
    raw.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut body = String::new();
    raw.read_to_string(&mut body).await.unwrap();
    assert!(body.starts_with("HTTP/1.1 200 OK"), "{body}");
}

#[tokio::test]
async fn tls_listener_relays_over_wss() {
    use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer, ServerName};
    use tokio_rustls::rustls::{crypto::ring, ClientConfig, RootCertStore};

    let (port, _seen) = fake_pi_host().await;
    let dir = tempfile::tempdir().unwrap();
    let certified = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert_path = dir.path().join("cert.pem");
    let key_path = dir.path().join("key.pem");
    std::fs::write(&cert_path, certified.cert.pem()).unwrap();
    std::fs::write(&key_path, certified.signing_key.serialize_pem()).unwrap();
    let args: Vec<String> = [
        "--listen",
        "127.0.0.1:0",
        "--upstream",
        &format!("ws://127.0.0.1:{port}"),
        "--tls-cert",
        cert_path.to_str().unwrap(),
        "--tls-key",
        key_path.to_str().unwrap(),
        "--public-host",
        "localhost",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let addr = start(GatewayConfig::parse(&args).unwrap(), 10).await;

    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(certified.cert.pem().as_bytes()).unwrap())
        .unwrap();
    let client = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(addr).await.unwrap();
    let tls = tokio_rustls::TlsConnector::from(Arc::new(client))
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .unwrap();
    let mut request = format!("wss://localhost:{}/v1/racp/ws", addr.port())
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(RACP_WS_SUBPROTOCOL),
    );
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {GOOD_DEVICE}")).unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::client_async(request, tls)
        .await
        .expect("wss upgrade");
    ws.send(Message::Text("hi".into())).await.unwrap();
    match tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
    {
        Some(Ok(Message::Text(text))) => assert_eq!(text.as_str(), "echo:hi"),
        other => panic!("expected echo, got {other:?}"),
    }
}
