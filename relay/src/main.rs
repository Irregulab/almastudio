//! The AlmaStudio relay: lets the companion app reach a desktop that is not on
//! its network.
//!
//! It never sees anything but ciphertext. The app and the desktop run the
//! Noise handshake end to end through it, so all it does is pair sockets:
//!
//! * A desktop keeps a control socket open on `/v1/desktop/{room}`, where the
//!   room is a hash of its public key. It proves it holds the matching
//!   private key first, so nobody else can take its room.
//! * An app connects to `/v1/client/{room}`. The relay tells the desktop,
//!   which opens `/v1/accept/{room}/{id}` with the one-time token it was
//!   given, and from then on the two sockets are piped together, frame by
//!   frame.
//!
//! Nothing is stored; a restart only drops the connections in flight.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, Mutex};

/// Must match `relayRoom` in packages/protocol/src/relay.ts.
const ROOM_CONTEXT: &[u8] = b"almastudio-room-v1";
const AUTH_CONTEXT: &[u8] = b"almastudio-relay-auth-v1";
/// How long an app waits for its desktop to pick up.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(10);
/// Apps waiting on one desktop at once; more are turned away.
const MAX_PENDING: usize = 16;
/// The largest frame forwarded. Noise messages are at most 64 KiB.
const MAX_FRAME: usize = 70 * 1024;

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn from_b64url(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

pub fn room_of(public_key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(ROOM_CONTEXT);
    h.update(public_key);
    b64url(&h.finalize())[..32].to_string()
}

/// What proves the desktop holds its key: a hash of a Diffie-Hellman result
/// only the holder of the private key and of the relay's ephemeral key share.
pub fn auth_proof(shared: &[u8; 32], nonce: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(AUTH_CONTEXT);
    h.update(shared);
    h.update(nonce);
    h.finalize().to_vec()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("system randomness");
    b
}

/// An app waiting for its desktop to accept.
struct Pending {
    token: String,
    tx: oneshot::Sender<WebSocket>,
}

struct Room {
    /// Messages for the desktop's control socket.
    control: mpsc::Sender<String>,
    /// Identifies this control socket, so an old one closing does not remove
    /// the room a newer one now holds.
    session: u64,
    pending: HashMap<u64, Pending>,
}

#[derive(Default)]
struct Relay {
    rooms: Mutex<HashMap<String, Room>>,
    next: AtomicU64,
}

type Shared = Arc<Relay>;

pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/desktop/{room}", get(desktop))
        .route("/v1/client/{room}", get(client))
        .route("/v1/accept/{room}/{id}", get(accept))
        .with_state(Shared::default())
}

#[tokio::main]
async fn main() {
    let addr: SocketAddr = std::env::var("RELAY_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()
        .expect("RELAY_ADDR");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    eprintln!("almastudio-relay listening on {addr}");
    axum::serve(listener, router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}

fn valid_room(room: &str) -> bool {
    room.len() == 32 && room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Desktop control socket
// ---------------------------------------------------------------------------

async fn desktop(ws: WebSocketUpgrade, Path(room): Path<String>, State(relay): State<Shared>) -> Response {
    if !valid_room(&room) {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.max_frame_size(16 * 1024)
        .on_upgrade(move |socket| run_desktop(socket, room, relay))
}

#[derive(Deserialize)]
struct Auth {
    key: String,
    proof: String,
}

async fn run_desktop(mut socket: WebSocket, room: String, relay: Shared) {
    // Challenge: prove the private key behind this room.
    let eph_secret = x25519_dalek::StaticSecret::from(random::<32>());
    let eph_public = x25519_dalek::PublicKey::from(&eph_secret);
    let nonce = random::<16>();
    let challenge = json!({ "t": "challenge", "eph": b64url(eph_public.as_bytes()), "nonce": b64url(&nonce) });
    if socket.send(Message::Text(challenge.to_string().into())).await.is_err() {
        return;
    }
    let answer = tokio::time::timeout(Duration::from_secs(10), socket.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = answer else { return };
    let Ok(auth) = serde_json::from_str::<Auth>(&text) else { return };
    let (Some(key), Some(proof)) = (from_b64url(&auth.key), from_b64url(&auth.proof)) else { return };
    let Ok(key): Result<[u8; 32], _> = key.try_into() else { return };
    if room_of(&key) != room {
        return;
    }
    let shared = eph_secret.diffie_hellman(&x25519_dalek::PublicKey::from(key));
    if auth_proof(shared.as_bytes(), &nonce) != proof {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    let (tx, mut rx) = mpsc::channel::<String>(64);
    let session = relay.next.fetch_add(1, Ordering::Relaxed);
    {
        let mut rooms = relay.rooms.lock().await;
        // A newer desktop connection replaces an older one, which is likely a
        // socket that died without closing.
        rooms.insert(room.clone(), Room { control: tx, session, pending: HashMap::new() });
    }
    if socket.send(Message::Text(json!({ "t": "ready" }).to_string().into())).await.is_err() {
        return;
    }

    let mut ping = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                if socket.send(Message::Text(msg.into())).await.is_err() { break }
            }
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break }
            }
        }
    }
    let mut rooms = relay.rooms.lock().await;
    if rooms.get(&room).is_some_and(|r| r.session == session) {
        rooms.remove(&room);
    }
}

// ---------------------------------------------------------------------------
// App connections
// ---------------------------------------------------------------------------

async fn client(ws: WebSocketUpgrade, Path(room): Path<String>, State(relay): State<Shared>) -> Response {
    if !valid_room(&room) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Refused before upgrading when the desktop is not there, so the app
    // gives up on this route at once instead of after a timeout.
    if !relay.rooms.lock().await.contains_key(&room) {
        return (StatusCode::SERVICE_UNAVAILABLE, "desktop offline").into_response();
    }
    ws.max_frame_size(MAX_FRAME)
        .max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| run_client(socket, room, relay))
}

async fn run_client(socket: WebSocket, room: String, relay: Shared) {
    let id = relay.next.fetch_add(1, Ordering::Relaxed);
    let token = b64url(&random::<16>());
    let (tx, rx) = oneshot::channel();
    {
        let mut rooms = relay.rooms.lock().await;
        let Some(r) = rooms.get_mut(&room) else { return };
        if r.pending.len() >= MAX_PENDING {
            return;
        }
        r.pending.insert(id, Pending { token: token.clone(), tx });
        let open = json!({ "t": "open", "id": id.to_string(), "token": token });
        if r.control.try_send(open.to_string()).is_err() {
            r.pending.remove(&id);
            return;
        }
    }
    let desktop = tokio::time::timeout(ACCEPT_TIMEOUT, rx).await;
    if let Some(r) = relay.rooms.lock().await.get_mut(&room) {
        r.pending.remove(&id);
    }
    let Ok(Ok(desktop)) = desktop else { return };
    pipe(socket, desktop).await;
}

#[derive(Deserialize)]
struct AcceptQuery {
    token: String,
}

async fn accept(
    ws: WebSocketUpgrade,
    Path((room, id)): Path<(String, u64)>,
    Query(q): Query<AcceptQuery>,
    State(relay): State<Shared>,
) -> Response {
    let pending = {
        let mut rooms = relay.rooms.lock().await;
        let Some(r) = rooms.get_mut(&room) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        match r.pending.get(&id) {
            Some(p) if p.token == q.token => r.pending.remove(&id),
            _ => None,
        }
    };
    let Some(pending) = pending else { return StatusCode::NOT_FOUND.into_response() };
    ws.max_frame_size(MAX_FRAME)
        .max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| async move {
            let _ = pending.tx.send(socket);
        })
}

/// Forwards binary frames both ways until either side closes.
async fn pipe(a: WebSocket, b: WebSocket) {
    let (mut a_tx, mut a_rx) = a.split();
    let (mut b_tx, mut b_rx) = b.split();
    let up = async {
        while let Some(Ok(msg)) = a_rx.next().await {
            match msg {
                Message::Binary(_) => {
                    if b_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = b_tx.close().await;
    };
    let down = async {
        while let Some(Ok(msg)) = b_rx.next().await {
            match msg {
                Message::Binary(_) => {
                    if a_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = a_tx.close().await;
    };
    // Whichever direction ends first ends the pair.
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    async fn start() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router()).await.unwrap() });
        format!("ws://{addr}")
    }

    /// Connects a desktop and authenticates it the way the app's desktop does.
    async fn desktop(
        base: &str,
        secret: &x25519_dalek::StaticSecret,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        let public = x25519_dalek::PublicKey::from(secret);
        let room = room_of(public.as_bytes());
        let (mut ws, _) = connect_async(format!("{base}/v1/desktop/{room}")).await.unwrap();
        let TMsg::Text(t) = ws.next().await.unwrap().unwrap() else { panic!() };
        let c: serde_json::Value = serde_json::from_str(&t).unwrap();
        let eph: [u8; 32] = from_b64url(c["eph"].as_str().unwrap()).unwrap().try_into().unwrap();
        let nonce = from_b64url(c["nonce"].as_str().unwrap()).unwrap();
        let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(eph));
        let auth = json!({ "key": b64url(public.as_bytes()), "proof": b64url(&auth_proof(shared.as_bytes(), &nonce)) });
        ws.send(TMsg::Text(auth.to_string().into())).await.unwrap();
        let TMsg::Text(t) = ws.next().await.unwrap().unwrap() else { panic!() };
        assert!(t.contains("ready"));
        ws
    }

    #[tokio::test]
    async fn pipes_an_app_to_its_desktop() {
        let base = start().await;
        let secret = x25519_dalek::StaticSecret::from([7u8; 32]);
        let room = room_of(x25519_dalek::PublicKey::from(&secret).as_bytes());
        let mut control = desktop(&base, &secret).await;

        let app = tokio::spawn({
            let base = base.clone();
            let room = room.clone();
            async move {
                let (mut ws, _) = connect_async(format!("{base}/v1/client/{room}")).await.unwrap();
                ws.send(TMsg::Binary(b"hello desktop".to_vec().into())).await.unwrap();
                let TMsg::Binary(b) = ws.next().await.unwrap().unwrap() else { panic!() };
                b.to_vec()
            }
        });

        let TMsg::Text(t) = control.next().await.unwrap().unwrap() else { panic!() };
        let open: serde_json::Value = serde_json::from_str(&t).unwrap();
        let (id, token) = (open["id"].as_str().unwrap(), open["token"].as_str().unwrap());
        let (mut leg, _) =
            connect_async(format!("{base}/v1/accept/{room}/{id}?token={token}")).await.unwrap();
        let TMsg::Binary(b) = leg.next().await.unwrap().unwrap() else { panic!() };
        assert_eq!(&b[..], b"hello desktop");
        leg.send(TMsg::Binary(b"hello app".to_vec().into())).await.unwrap();
        assert_eq!(app.await.unwrap(), b"hello app");
    }

    #[tokio::test]
    async fn refuses_a_desktop_without_the_key() {
        let base = start().await;
        let owner = x25519_dalek::StaticSecret::from([7u8; 32]);
        let room = room_of(x25519_dalek::PublicKey::from(&owner).as_bytes());
        let (mut ws, _) = connect_async(format!("{base}/v1/desktop/{room}")).await.unwrap();
        let _challenge = ws.next().await.unwrap().unwrap();
        // Claims the room's key, but cannot compute the proof for it.
        let auth = json!({
            "key": b64url(x25519_dalek::PublicKey::from(&owner).as_bytes()),
            "proof": b64url(&[0u8; 32]),
        });
        ws.send(TMsg::Text(auth.to_string().into())).await.unwrap();
        let next = ws.next().await;
        assert!(!matches!(next, Some(Ok(TMsg::Text(t))) if t.contains("ready")));
        // And the room stays empty for apps.
        assert!(connect_async(format!("{base}/v1/client/{room}")).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_wrong_accept_token() {
        let base = start().await;
        let secret = x25519_dalek::StaticSecret::from([9u8; 32]);
        let room = room_of(x25519_dalek::PublicKey::from(&secret).as_bytes());
        let mut control = desktop(&base, &secret).await;
        let _app = tokio::spawn({
            let base = base.clone();
            let room = room.clone();
            async move { connect_async(format!("{base}/v1/client/{room}")).await }
        });
        let TMsg::Text(t) = control.next().await.unwrap().unwrap() else { panic!() };
        let open: serde_json::Value = serde_json::from_str(&t).unwrap();
        let id = open["id"].as_str().unwrap();
        assert!(connect_async(format!("{base}/v1/accept/{room}/{id}?token=nope")).await.is_err());
    }

    #[test]
    fn room_matches_the_app() {
        // relayRoom in packages/protocol/src/relay.ts and room_of in the
        // desktop give the same, for a key of 32 × 0x01.
        assert_eq!(room_of(&[1u8; 32]), "zTRx9g6V1lbAUoRsCUzp0RaB2ZKc15yk");
    }
}
