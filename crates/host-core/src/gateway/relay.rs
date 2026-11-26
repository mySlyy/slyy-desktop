//! The upstream leg: one loopback RACP-WS connection to pi-host per device
//! connection, and the frame pump between the two.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::{interval, timeout, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{
    HeaderValue, AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL,
};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

use super::config::{GatewayConfig, RACP_WS_SUBPROTOCOL};

const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const UPSTREAM_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Mobile radios drop idle NAT mappings; a ping every 25 s keeps them and
/// detects a vanished phone within two intervals.
pub const DEVICE_PING_INTERVAL: Duration = Duration::from_secs(25);

#[derive(Debug)]
pub enum UpstreamError {
    /// pi-host answered the upgrade with this HTTP status (401/403 = credential refused).
    Rejected(u16),
    Unavailable(String),
}

pub fn ws_config(config: &GatewayConfig) -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(config.max_message_bytes))
        .max_frame_size(Some(config.max_message_bytes))
}

pub async fn connect_upstream(
    config: &GatewayConfig,
    authorization: &str,
) -> Result<WebSocketStream<TcpStream>, UpstreamError> {
    let unavailable = |e: &dyn std::fmt::Display| UpstreamError::Unavailable(e.to_string());
    let tcp = timeout(
        UPSTREAM_CONNECT_TIMEOUT,
        TcpStream::connect((config.upstream_host, config.upstream_port)),
    )
    .await
    .map_err(|e| unavailable(&e))?
    .map_err(|e| unavailable(&e))?;
    tcp.set_nodelay(true).map_err(|e| unavailable(&e))?;
    let mut request = config
        .upstream_url()
        .into_client_request()
        .map_err(|e| unavailable(&e))?;
    let headers = request.headers_mut();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(authorization).map_err(|e| unavailable(&e))?,
    );
    headers.insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(RACP_WS_SUBPROTOCOL),
    );
    let handshake =
        tokio_tungstenite::client_async_with_config(request, tcp, Some(ws_config(config)));
    match timeout(UPSTREAM_HANDSHAKE_TIMEOUT, handshake).await {
        Ok(Ok((stream, _response))) => Ok(stream),
        Ok(Err(WsError::Http(response))) => {
            Err(UpstreamError::Rejected(response.status().as_u16()))
        }
        Ok(Err(error)) => Err(unavailable(&error)),
        Err(elapsed) => Err(unavailable(&elapsed)),
    }
}

fn close_frame(code: CloseCode, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Relay text frames both ways until either side closes. RACP-WS is
/// text-only JSON-RPC (spec §11.1); a binary frame from either side ends
/// the session with 1003 instead of being passed through.
pub async fn pump<D, U>(device: WebSocketStream<D>, host: WebSocketStream<U>)
where
    D: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (mut device_tx, mut device_rx) = device.split();
    let (mut host_tx, mut host_rx) = host.split();
    let mut ping = interval(DEVICE_PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            frame = device_rx.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    if host_tx.send(Message::Text(text)).await.is_err() {
                        let _ = device_tx.send(close_frame(CloseCode::Away, "host unavailable")).await;
                        break;
                    }
                }
                Some(Ok(Message::Pong(_))) => awaiting_pong = false,
                Some(Ok(Message::Ping(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Binary(_))) => {
                    let _ = device_tx.send(close_frame(CloseCode::Unsupported, "binary frames are not accepted")).await;
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = host_tx.send(Message::Close(frame)).await;
                    break;
                }
                Some(Err(error)) => {
                    tracing::debug!(%error, "device socket ended");
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
                None => {
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
            },
            frame = host_rx.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    if device_tx.send(Message::Text(text)).await.is_err() {
                        let _ = host_tx.send(Message::Close(None)).await;
                        break;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Binary(_))) => {
                    tracing::warn!("pi-host sent a binary frame; closing");
                    let _ = device_tx.send(close_frame(CloseCode::Error, "protocol error")).await;
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = device_tx.send(Message::Close(frame)).await;
                    break;
                }
                Some(Err(_)) | None => {
                    let _ = device_tx.send(close_frame(CloseCode::Away, "host unavailable")).await;
                    break;
                }
            },
            _ = ping.tick() => {
                if awaiting_pong {
                    tracing::debug!("device missed a pong; dropping");
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
                awaiting_pong = true;
                if device_tx.send(Message::Ping(Default::default())).await.is_err() {
                    let _ = host_tx.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }
}
