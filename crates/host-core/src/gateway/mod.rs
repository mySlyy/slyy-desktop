//! Gateway mode (`pi-desktop-host-core --gateway`): the single public
//! entry point of a user's Slyy VM. It terminates TLS, applies perimeter
//! checks to the RACP-WS upgrade, and relays each device connection to
//! pi-host's loopback RACP-WS listener. pi-host stays the only credential
//! authority; the gateway never stores tokens and never opens SQLite.
//! See `docs/adr/slyy-gateway-mode.md`.

mod config;
mod handshake;
mod relay;
#[cfg(test)]
mod tests;
mod throttle;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

pub use config::GatewayConfig;
use config::TlsFiles;
use handshake::{Decision, MAX_HEAD_BYTES};
use relay::UpstreamError;
use throttle::AuthThrottle;

pub const GATEWAY_FLAG: &str = "--gateway";
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn requested() -> bool {
    std::env::args().any(|arg| arg == GATEWAY_FLAG)
}

pub async fn run_from_args() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = GatewayConfig::parse(&args)?;
    let gateway = Gateway::bind(config).await?;
    tracing::info!(addr = %gateway.local_addr(), tls = gateway.shared.tls.is_some(), "gateway listening");
    tokio::select! {
        result = gateway.serve() => result,
        _ = shutdown_signal() => {
            tracing::info!("gateway stopping");
            Ok(())
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

struct Shared {
    config: GatewayConfig,
    tls: Option<TlsAcceptor>,
    throttle: AuthThrottle,
    slots: Arc<Semaphore>,
}

pub struct Gateway {
    listener: TcpListener,
    shared: Arc<Shared>,
}

impl Gateway {
    pub async fn bind(config: GatewayConfig) -> anyhow::Result<Self> {
        Self::bind_with_throttle(
            config,
            AuthThrottle::new(throttle::DEFAULT_WINDOW, throttle::DEFAULT_MAX_FAILURES),
        )
        .await
    }

    async fn bind_with_throttle(
        config: GatewayConfig,
        throttle: AuthThrottle,
    ) -> anyhow::Result<Self> {
        let tls = config.tls.as_ref().map(tls_acceptor).transpose()?;
        let listener = TcpListener::bind(config.listen)
            .await
            .with_context(|| format!("bind {}", config.listen))?;
        let slots = Arc::new(Semaphore::new(config.max_connections));
        Ok(Self {
            listener,
            shared: Arc::new(Shared {
                config,
                tls,
                throttle,
                slots,
            }),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.listener
            .local_addr()
            .unwrap_or(self.shared.config.listen)
    }

    pub async fn serve(self) -> anyhow::Result<()> {
        loop {
            let (tcp, peer) = match self.listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    // EMFILE and friends are transient; keep the listener alive.
                    tracing::warn!(%error, "accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let shared = self.shared.clone();
            tokio::spawn(async move {
                if let Err(error) = handle_tcp(shared, tcp, peer).await {
                    tracing::debug!(%peer, error = %format!("{error:#}"), "connection ended early");
                }
            });
        }
    }
}

fn tls_acceptor(files: &TlsFiles) -> anyhow::Result<TlsAcceptor> {
    use tokio_rustls::rustls::pki_types::pem::PemObject;
    use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use tokio_rustls::rustls::{crypto::ring, ServerConfig};

    let certs = CertificateDer::pem_file_iter(&files.cert)
        .with_context(|| format!("read {}", files.cert.display()))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("parse {}", files.cert.display()))?;
    let key = PrivateKeyDer::from_pem_file(&files.key)
        .with_context(|| format!("read key {}", files.key.display()))?;
    let mut server = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(server)))
}

async fn handle_tcp(shared: Arc<Shared>, tcp: TcpStream, peer: SocketAddr) -> anyhow::Result<()> {
    tcp.set_nodelay(true)?;
    match &shared.tls {
        Some(acceptor) => {
            let stream = timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await??;
            handle_stream(&shared, stream, peer.ip()).await
        }
        None => handle_stream(&shared, tcp, peer.ip()).await,
    }
}

async fn read_head<S: AsyncRead + Unpin>(
    io: &mut S,
    config: &GatewayConfig,
) -> anyhow::Result<(Decision, bool)> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let read = io.read(&mut chunk).await?;
        anyhow::ensure!(read > 0, "peer closed before sending a request");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some((decision, consumed)) = handshake::inspect(&buffer, config) {
            return Ok((decision, buffer.len() > consumed));
        }
        if buffer.len() >= MAX_HEAD_BYTES {
            return Ok((Decision::Refuse(handshake::Refusal::BadRequest), false));
        }
    }
}

async fn respond<S: AsyncWrite + Unpin>(io: &mut S, status: u16, body: &str) -> anyhow::Result<()> {
    io.write_all(handshake::plain_response(status, body).as_bytes())
        .await?;
    io.shutdown().await?;
    Ok(())
}

async fn handle_stream<S>(shared: &Shared, mut io: S, peer: IpAddr) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (decision, pipelined) = timeout(HEAD_TIMEOUT, read_head(&mut io, &shared.config)).await??;
    let upgrade = match decision {
        Decision::Health => return respond(&mut io, 200, "ok\n").await,
        Decision::Refuse(refusal) => {
            if refusal.counts_as_auth_failure() {
                shared.throttle.record_failure(peer, Instant::now());
            }
            let status = handshake::refusal_status(refusal);
            tracing::info!(%peer, status, "upgrade refused");
            return respond(&mut io, status, "").await;
        }
        Decision::Upgrade(upgrade) => upgrade,
    };
    if shared.throttle.is_blocked(peer, Instant::now()) {
        tracing::warn!(%peer, "upgrade throttled after repeated credential failures");
        return respond(&mut io, 429, "").await;
    }
    if pipelined {
        return respond(&mut io, 400, "").await;
    }
    let Ok(_slot) = shared.slots.clone().try_acquire_owned() else {
        tracing::warn!(%peer, "connection limit reached");
        return respond(&mut io, 503, "").await;
    };
    let host = match relay::connect_upstream(&shared.config, &upgrade.authorization).await {
        Ok(host) => host,
        Err(UpstreamError::Rejected(status @ (401 | 403))) => {
            shared.throttle.record_failure(peer, Instant::now());
            tracing::info!(%peer, status, "credential refused by pi-host");
            return respond(&mut io, status, "").await;
        }
        Err(UpstreamError::Rejected(status)) => {
            tracing::warn!(%peer, status, "pi-host refused the upgrade");
            return respond(&mut io, 502, "").await;
        }
        Err(UpstreamError::Unavailable(error)) => {
            tracing::warn!(%peer, %error, "pi-host unavailable");
            return respond(&mut io, 502, "").await;
        }
    };
    io.write_all(handshake::switching_protocols(&upgrade.websocket_key).as_bytes())
        .await?;
    io.flush().await?;
    let device =
        WebSocketStream::from_raw_socket(io, Role::Server, Some(relay::ws_config(&shared.config)))
            .await;
    tracing::info!(%peer, "device connected");
    relay::pump(device, host).await;
    tracing::info!(%peer, "device disconnected");
    Ok(())
}
