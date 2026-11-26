//! Command-line configuration for gateway mode.
//!
//! `pi-desktop-host-core --gateway --listen <addr:port> --upstream <ws-url>
//!   [--tls-cert <pem> --tls-key <pem>] [--public-host <name>]
//!   [--allow-origin <origin>]... [--max-connections <n>]`

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// RACP-WS constants mirrored from `packages/shared/src/racp.ts`. The
/// `racp_constants_match_shared_contract` test keeps both copies equal.
pub const RACP_WS_PATH: &str = "/v1/racp/ws";
pub const RACP_WS_SUBPROTOCOL: &str = "pi-racp.v1.jsonrpc";
pub const RACP_DEVICE_TOKEN_PREFIX: &str = "pdt1.";
pub const RACP_PAIRING_TOKEN_PREFIX: &str = "ppt1.";

/// pi-host enforces its own 1 MiB RACP frame limit and answers oversized
/// frames with a JSON-RPC error; the gateway cap sits above it so that error
/// path stays reachable, and only drops frames no RACP peer may send.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_CONNECTIONS: usize = 256;

#[derive(Debug, Clone)]
pub struct TlsFiles {
    pub cert: PathBuf,
    pub key: PathBuf,
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub listen: SocketAddr,
    /// pi-host's loopback RACP endpoint, e.g. `ws://127.0.0.1:7319/v1/racp/ws`.
    pub upstream_host: IpAddr,
    pub upstream_port: u16,
    pub tls: Option<TlsFiles>,
    /// When set, the `Host` header must name this host (port ignored). The
    /// edge router routes by SNI, so a mismatch means a misrouted request.
    pub public_host: Option<String>,
    /// Browser origins allowed to open a socket. Native apps send no Origin;
    /// any request that carries one not listed here is refused.
    pub allowed_origins: Vec<String>,
    pub max_connections: usize,
    pub max_message_bytes: usize,
}

#[derive(Debug, thiserror::Error)]
#[error("gateway configuration: {0}")]
pub struct ConfigError(pub String);

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

impl GatewayConfig {
    pub fn parse(args: &[String]) -> Result<Self, ConfigError> {
        let mut listen = None;
        let mut upstream = None;
        let mut cert = None;
        let mut key = None;
        let mut public_host = None;
        let mut allowed_origins = Vec::new();
        let mut max_connections = DEFAULT_MAX_CONNECTIONS;
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            let mut value = |name: &str| -> Result<String, ConfigError> {
                iter.next()
                    .cloned()
                    .ok_or_else(|| ConfigError(format!("{name} needs a value")))
            };
            match arg.as_str() {
                "--gateway" => {}
                "--listen" => listen = Some(value("--listen")?),
                "--upstream" => upstream = Some(value("--upstream")?),
                "--tls-cert" => cert = Some(PathBuf::from(value("--tls-cert")?)),
                "--tls-key" => key = Some(PathBuf::from(value("--tls-key")?)),
                "--public-host" => public_host = Some(value("--public-host")?.to_ascii_lowercase()),
                "--allow-origin" => allowed_origins.push(value("--allow-origin")?),
                "--max-connections" => {
                    let raw = value("--max-connections")?;
                    max_connections = match raw.parse::<usize>() {
                        Ok(n) if n > 0 => n,
                        _ => return err(format!("invalid --max-connections {raw}")),
                    };
                }
                other => return err(format!("unknown argument {other}")),
            }
        }
        let listen: SocketAddr = match listen {
            Some(raw) => raw
                .parse()
                .map_err(|_| ConfigError(format!("invalid --listen {raw}")))?,
            None => return err("--listen is required"),
        };
        let (upstream_host, upstream_port) = match upstream {
            Some(raw) => parse_upstream(&raw)?,
            None => return err("--upstream is required"),
        };
        let tls = match (cert, key) {
            (Some(cert), Some(key)) => Some(TlsFiles { cert, key }),
            (None, None) => None,
            _ => return err("--tls-cert and --tls-key go together"),
        };
        if tls.is_none() && !listen.ip().is_loopback() {
            return err("a non-loopback --listen requires --tls-cert and --tls-key");
        }
        Ok(Self {
            listen,
            upstream_host,
            upstream_port,
            tls,
            public_host,
            allowed_origins,
            max_connections,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
        })
    }

    pub fn upstream_url(&self) -> String {
        let host = match self.upstream_host {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        format!("ws://{host}:{}{RACP_WS_PATH}", self.upstream_port)
    }
}

/// Only a plain `ws://` loopback pi-host is a valid upstream: credentials
/// never leave the VM, and pi-host itself refuses non-loopback peers.
fn parse_upstream(raw: &str) -> Result<(IpAddr, u16), ConfigError> {
    let Some(rest) = raw.strip_prefix("ws://") else {
        return err("--upstream must be a ws:// loopback URL");
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let addr: SocketAddr = authority
        .replace("localhost", "127.0.0.1")
        .parse()
        .map_err(|_| ConfigError(format!("invalid --upstream {raw}")))?;
    if !addr.ip().is_loopback() {
        return err("--upstream must be a loopback address");
    }
    Ok((addr.ip(), addr.port()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn loopback_listen_without_tls_is_accepted() {
        let config = GatewayConfig::parse(&args(&[
            "--gateway",
            "--listen",
            "127.0.0.1:0",
            "--upstream",
            "ws://127.0.0.1:7319/v1/racp/ws",
        ]))
        .expect("valid config");
        assert!(config.tls.is_none());
        assert_eq!(config.upstream_url(), "ws://127.0.0.1:7319/v1/racp/ws");
    }

    #[test]
    fn public_listen_requires_tls() {
        let error = GatewayConfig::parse(&args(&[
            "--listen",
            "0.0.0.0:8443",
            "--upstream",
            "ws://127.0.0.1:7319",
        ]))
        .unwrap_err();
        assert!(error.0.contains("requires --tls-cert"));
    }

    #[test]
    fn upstream_must_be_plain_loopback() {
        for bad in [
            "wss://127.0.0.1:1",
            "ws://10.0.0.2:7319",
            "http://127.0.0.1:1",
        ] {
            let parsed =
                GatewayConfig::parse(&args(&["--listen", "127.0.0.1:0", "--upstream", bad]));
            assert!(parsed.is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn racp_constants_match_shared_contract() {
        let contract = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/racp.ts"
        ))
        .expect("shared RACP contract is readable");
        for (name, value) in [
            ("RACP_WS_PATH", RACP_WS_PATH),
            ("RACP_WS_SUBPROTOCOL", RACP_WS_SUBPROTOCOL),
            ("RACP_DEVICE_TOKEN_PREFIX", RACP_DEVICE_TOKEN_PREFIX),
            ("RACP_PAIRING_TOKEN_PREFIX", RACP_PAIRING_TOKEN_PREFIX),
        ] {
            let needle = format!("export const {name} = \"{value}\" as const;");
            assert!(
                contract.contains(&needle),
                "{name} drifted from the shared contract"
            );
        }
    }
}
