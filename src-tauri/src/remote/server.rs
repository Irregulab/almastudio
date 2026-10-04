//! The listener on the local network and the per-connection loop.
//!
//! `serve` runs one connection from handshake to close. It is generic over the
//! byte stream under the WebSocket, so a connection the relay hands over runs
//! exactly the same code as one accepted on the LAN.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::identity::b64url;
use super::noise::{self, Channel};
use super::{requests, Hello, Link, RemoteHub, CLIENT_QUEUE};

/// The first handshake message must arrive within this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The app pings every 15 s; a connection silent for this long is dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);

pub async fn run(app: AppHandle, listener: TcpListener, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, addr)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                let shutdown = shutdown.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                        serve(app, ws, addr.ip().to_string(), "lan", shutdown).await;
                    }
                });
            }
            _ = shutdown.changed() => break,
        }
    }
}

async fn next_binary<S>(ws: &mut WebSocketStream<S>) -> Option<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    while let Some(msg) = ws.next().await {
        match msg.ok()? {
            Message::Binary(b) => return Some(b.to_vec()),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
    None
}

/// Runs one connection: the Noise handshake, admission, then the message loop
/// until either side goes away.
pub async fn serve<S>(
    app: AppHandle,
    mut ws: WebSocketStream<S>,
    addr: String,
    via: &'static str,
    mut shutdown: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let hub = app.state::<RemoteHub>();
    let Ok(identity) = hub.identity(&app) else { return };
    let Ok(Some(first)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, next_binary(&mut ws)).await
    else {
        return;
    };
    let Ok(private) = identity.private_bytes() else { return };
    let Ok(mut hs) = noise::responder(&private) else { return };
    // Fails unless the phone encrypted to this desktop's key.
    let Ok(payload) = noise::read_handshake(&mut hs, &first) else { return };
    let hello: Hello = serde_json::from_slice(&payload).unwrap_or(Hello {
        name: String::new(),
        platform: String::new(),
        app: String::new(),
        token: None,
    });
    let Some(key) = hs.get_remote_static().map(b64url) else { return };

    let verdict = hub.admit(&app, &key, &hello).await;
    let reply = match &verdict {
        Ok(()) => json!({
            "ok": true,
            "desktop": {
                "name": hub.inner.lock().name.clone(),
                "version": app.package_info().version.to_string(),
                "os": std::env::consts::OS,
            },
        }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let Ok(second) = noise::write_handshake(&mut hs, reply.to_string().as_bytes()) else {
        return;
    };
    if ws.send(Message::Binary(second.into())).await.is_err() || verdict.is_err() {
        let _ = ws.close(None).await;
        return;
    }
    let Ok(mut channel) = Channel::new(hs) else { return };

    let (tx, mut rx) = mpsc::channel::<String>(CLIENT_QUEUE);
    let kick = Arc::new(Notify::new());
    let client = hub.add_client(&app, key, &hello, Link { addr, via, tx, kick: kick.clone() });

    let mut last_in = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Binary(frame))) => {
                    last_in = Instant::now();
                    match channel.open(&frame) {
                        Ok(Some(plain)) => requests::handle(&app, client, plain),
                        Ok(None) => {}
                        // A frame that does not decrypt means a broken or
                        // tampered stream; nothing after it can be trusted.
                        Err(_) => break,
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => last_in = Instant::now(),
            },
            outgoing = rx.recv() => {
                let Some(text) = outgoing else { break };
                let Ok(frames) = channel.seal(text.as_bytes()) else { break };
                let mut failed = false;
                for frame in frames {
                    if ws.send(Message::Binary(frame.into())).await.is_err() {
                        failed = true;
                        break;
                    }
                }
                if failed { break }
            }
            _ = kick.notified() => break,
            _ = shutdown.changed() => break,
            _ = tick.tick() => {
                if last_in.elapsed() > IDLE_TIMEOUT { break }
            }
        }
    }
    let _ = ws.close(None).await;
    hub.remove_client(&app, client);
}
