//! The desktop's side of the relay, for reaching it from outside its network.
//!
//! A control socket stays open to the relay. When an app connects there, the
//! relay says so on that socket, and the desktop opens one more socket for
//! that app and runs the very same `server::serve` on it as for a LAN
//! connection: the Noise handshake, admission, the message loop. The relay
//! only ever forwards ciphertext; see relay/src/main.rs.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::identity::{b64url, from_b64url};
use super::{server, RemoteHub};

/// Must match the relay and `relayRoom` in packages/protocol/src/relay.ts.
const ROOM_CONTEXT: &[u8] = b"almastudio-room-v1";
const AUTH_CONTEXT: &[u8] = b"almastudio-relay-auth-v1";
const MAX_BACKOFF: Duration = Duration::from_secs(60);

pub fn room_of(public_key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(ROOM_CONTEXT);
    h.update(public_key);
    b64url(&h.finalize())[..32].to_string()
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

#[derive(Deserialize)]
struct Challenge {
    eph: String,
    nonce: String,
}

#[derive(Deserialize)]
struct Open {
    id: String,
    token: String,
}

/// Keeps the control socket up until `shutdown`, reconnecting with backoff.
pub async fn run(app: AppHandle, url: String, mut shutdown: watch::Receiver<bool>) {
    let mut delay = Duration::from_secs(1);
    loop {
        let result = session(&app, &url, &mut shutdown, &mut delay).await;
        if *shutdown.borrow() {
            break;
        }
        let hub = app.state::<RemoteHub>();
        hub.set_relay_state(&app, false, result.err().map(|e| e.to_string()));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => break,
        }
        delay = (delay * 2).min(MAX_BACKOFF);
    }
}

async fn session(
    app: &AppHandle,
    url: &str,
    shutdown: &mut watch::Receiver<bool>,
    delay: &mut Duration,
) -> anyhow::Result<()> {
    let hub = app.state::<RemoteHub>();
    let identity = hub.identity(app)?;
    let public = from_b64url(&identity.public)?;
    let private: [u8; 32] = identity
        .private_bytes()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad key"))?;
    let room = room_of(&public);
    let base = base(url);

    super::push::ensure_tls();
    let (mut ws, _) = connect_async(format!("{base}/v1/desktop/{room}")).await?;

    // Prove this desktop holds the key its room is named after.
    let Some(Ok(Message::Text(text))) = ws.next().await else {
        anyhow::bail!("relay closed during sign-in");
    };
    let challenge: Challenge = serde_json::from_str(&text)?;
    let eph: [u8; 32] = from_b64url(&challenge.eph)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad challenge"))?;
    let nonce = from_b64url(&challenge.nonce)?;
    let shared = x25519_dalek::StaticSecret::from(private)
        .diffie_hellman(&x25519_dalek::PublicKey::from(eph));
    let mut h = Sha256::new();
    h.update(AUTH_CONTEXT);
    h.update(shared.as_bytes());
    h.update(&nonce);
    let auth = json!({ "t": "auth", "key": identity.public, "proof": b64url(&h.finalize()) });
    ws.send(Message::Text(auth.to_string().into())).await?;
    match ws.next().await {
        Some(Ok(Message::Text(t))) if t.contains("\"ready\"") => {}
        _ => anyhow::bail!("the relay refused this desktop"),
    }
    hub.set_relay_state(app, true, None);
    *delay = Duration::from_secs(1);

    loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let Ok(open) = serde_json::from_str::<Open>(&t) else { continue };
                    let app = app.clone();
                    let shutdown = shutdown.clone();
                    let leg = format!("{base}/v1/accept/{room}/{}?token={}", open.id, open.token);
                    tauri::async_runtime::spawn(async move {
                        if let Ok((socket, _)) = connect_async(leg).await {
                            server::serve(app, socket, "relay".into(), "relay", shutdown).await;
                        }
                    });
                }
                Some(Ok(Message::Close(_))) | None => anyhow::bail!("the relay closed the connection"),
                Some(Err(e)) => return Err(e.into()),
                Some(Ok(_)) => {}
            },
            _ = shutdown.changed() => {
                let _ = ws.close(None).await;
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TLS works in this build: wss needs a rustls crypto provider, which
    /// only fails at run time. Needs the network, so run it by hand.
    #[tokio::test]
    #[ignore]
    async fn connects_over_tls() {
        let (mut ws, _) = connect_async("wss://echo.websocket.org").await.unwrap();
        ws.close(None).await.unwrap();
    }

    #[test]
    fn room_matches_the_app_and_the_relay() {
        // The same vector is checked in packages/protocol/src/relay.test.ts.
        assert_eq!(room_of(&[1u8; 32]), "zTRx9g6V1lbAUoRsCUzp0RaB2ZKc15yk");
    }
}
