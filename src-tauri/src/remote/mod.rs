//! Remote control from the companion app.
//!
//! Execution never leaves this machine. A paired phone or tablet connects —
//! directly on the local network, or through the relay — and is given a view
//! of the workspace, the output of any terminal and a way to type into it.
//!
//! * Terminal bytes go from the pty threads straight to the connected clients
//!   (`on_pty_data`), without a trip through the webview. With nobody
//!   connected that path costs one atomic load.
//! * Anything that changes the workspace — opening, closing or restarting a
//!   tab — is handed to the frontend (`forward_to_frontend`), which already
//!   owns the tabs and knows how to launch each harness. The desktop UI then
//!   shows the new tab too, exactly as if it had been opened there.
//! * The server is off until the user turns it on, and only paired devices
//!   get past the handshake; see `noise` and `identity`.

pub mod agent_events;
pub mod identity;
pub mod noise;
mod push;
mod relay_client;
mod requests;
mod server;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch, Notify};

use crate::pty::PtyManager;
use identity::{b64url, Device, Identity};

pub const DEFAULT_PORT: u16 = 47821;
/// How long a pairing code shown on screen stays valid.
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
/// How long the desktop waits for the user to allow a new device.
const PAIR_DECISION_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a forwarded command may take in the frontend.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// Messages queued for one client before it counts as stuck and is dropped.
/// The app reconnects and re-attaches by offset, so nothing is lost.
const CLIENT_QUEUE: usize = 2048;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Client {
    device_key: String,
    name: String,
    platform: String,
    addr: String,
    via: &'static str,
    app_version: String,
    tx: mpsc::Sender<String>,
    kick: Arc<Notify>,
    attached: HashSet<String>,
    connected_at: u64,
}

impl Client {
    /// Queues a message; a client too slow to keep up is disconnected.
    fn send(&self, msg: String) {
        if self.tx.try_send(msg).is_err() {
            self.kick.notify_one();
        }
    }
}

/// How a connected client is reached.
struct Link {
    addr: String,
    via: &'static str,
    tx: mpsc::Sender<String>,
    kick: Arc<Notify>,
}

struct Pairing {
    token: String,
    expires: Instant,
}

struct ServerHandle {
    port: u16,
    shutdown: watch::Sender<bool>,
}

struct RelayHandle {
    url: String,
    shutdown: watch::Sender<bool>,
    connected: bool,
    error: Option<String>,
}

#[derive(Default)]
struct Inner {
    identity: Option<Identity>,
    devices: Option<Vec<Device>>,
    name: String,
    server: Option<ServerHandle>,
    error: Option<String>,
    clients: HashMap<u64, Client>,
    next_id: u64,
    pairing: Option<Pairing>,
    pair_requests: HashMap<u64, oneshot::Sender<bool>>,
    commands: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    workspace: Value,
    /// The relay this desktop is reachable through, when that is on.
    relay_url: Option<String>,
    relay: Option<RelayHandle>,
    /// Push a notification when an agent finishes or waits.
    notify: bool,
    /// Leave project names and messages out of notifications.
    hide_names: bool,
    push: Option<HashMap<String, push::PushTarget>>,
}

#[derive(Default)]
pub struct RemoteHub {
    inner: Mutex<Inner>,
    /// Connected clients; lets the pty hot path skip the lock when zero.
    connected: AtomicUsize,
}

/// What a device says about itself in the first handshake message.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub app: String,
    /// The one-time code from the pairing QR, for a device not yet paired.
    #[serde(default)]
    pub token: Option<String>,
}

impl RemoteHub {
    fn identity(&self, app: &AppHandle) -> anyhow::Result<Identity> {
        let mut inner = self.inner.lock();
        if let Some(id) = &inner.identity {
            return Ok(id.clone());
        }
        let id = identity::load_or_create_identity(app)?;
        inner.identity = Some(id.clone());
        Ok(id)
    }

    fn with_devices<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<Device>) -> R) -> R {
        let mut inner = self.inner.lock();
        let devices = inner.devices.get_or_insert_with(|| identity::load_devices(app));
        f(devices)
    }

    /// Decides whether a device that completed the first handshake message may
    /// connect: a paired device may; an unknown one only with a valid pairing
    /// code and once the user has allowed it on this screen.
    async fn admit(&self, app: &AppHandle, key: &str, hello: &Hello) -> Result<(), String> {
        let known = self.with_devices(app, |devices| {
            let Some(d) = devices.iter_mut().find(|d| d.key == key) else { return false };
            d.last_seen = now_ms();
            if !hello.name.is_empty() {
                d.name = hello.name.clone();
            }
            true
        });
        if known {
            self.save_devices(app);
            return Ok(());
        }

        let Some(token) = hello.token.as_deref() else {
            return Err("not-paired".into());
        };
        // Development builds only: a fixed pairing code that needs no one at
        // the screen, so the app can be paired from a simulator or a test.
        #[cfg(debug_assertions)]
        if std::env::var("ALMASTUDIO_REMOTE_DEV_TOKEN").is_ok_and(|t| !t.is_empty() && t == token) {
            self.add_device(app, key, hello);
            return Ok(());
        }
        let (request_id, rx) = {
            let mut inner = self.inner.lock();
            let valid = inner
                .pairing
                .as_ref()
                .is_some_and(|p| p.expires > Instant::now() && constant_eq(&p.token, token));
            if !valid {
                return Err("invalid-code".into());
            }
            // Single use: a photo of the QR code is worthless afterwards.
            inner.pairing = None;
            inner.next_id += 1;
            let id = inner.next_id;
            let (tx, rx) = oneshot::channel();
            inner.pair_requests.insert(id, tx);
            (id, rx)
        };
        let _ = app.emit(
            "remote://pair-request",
            json!({ "requestId": request_id, "name": hello.name, "platform": hello.platform }),
        );
        let allowed = matches!(
            tokio::time::timeout(PAIR_DECISION_TIMEOUT, rx).await,
            Ok(Ok(true))
        );
        self.inner.lock().pair_requests.remove(&request_id);
        let _ = app.emit("remote://pair-request-done", json!({ "requestId": request_id }));
        if !allowed {
            return Err("denied".into());
        }
        self.add_device(app, key, hello);
        Ok(())
    }

    fn add_device(&self, app: &AppHandle, key: &str, hello: &Hello) {
        let now = now_ms();
        self.with_devices(app, |devices| {
            devices.retain(|d| d.key != key);
            devices.push(Device {
                key: key.to_string(),
                name: hello.name.clone(),
                platform: hello.platform.clone(),
                paired_at: now,
                last_seen: now,
            });
        });
        self.save_devices(app);
        self.changed(app);
    }

    /// What the workspace summary says about a tab: its kind, title, and
    /// project's id and name.
    fn tab_info(&self, tab_id: &str) -> Option<(String, String, String, String)> {
        let inner = self.inner.lock();
        let projects = inner.workspace.get("projects")?.as_array()?;
        for p in projects {
            for t in p.get("tabs").and_then(Value::as_array).into_iter().flatten() {
                if t.get("id").and_then(Value::as_str) == Some(tab_id) {
                    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    return Some((s(t, "kind"), s(t, "title"), s(p, "id"), s(p, "name")));
                }
            }
        }
        None
    }

    pub fn tab_kind(&self, tab_id: &str) -> Option<String> {
        self.tab_info(tab_id).map(|(kind, ..)| kind)
    }

    fn with_push<R>(&self, app: &AppHandle, f: impl FnOnce(&mut HashMap<String, push::PushTarget>) -> R) -> R {
        let mut inner = self.inner.lock();
        let targets = inner.push.get_or_insert_with(|| push::load(app));
        f(targets)
    }

    /// Tells connected devices, and pushes to the paired ones that are not.
    pub fn on_agent_event(&self, app: &AppHandle, event: &agent_events::AgentEvent) {
        let (kind, _title, project_id, project_name) =
            self.tab_info(&event.tab_id).unwrap_or_default();
        self.broadcast(event_msg(
            "agent",
            json!({
                "tabId": event.tab_id,
                "projectId": project_id,
                "kind": event.kind,
                "message": event.message,
            }),
        ));

        let (notify, hide, connected, desktop_id) = {
            let inner = self.inner.lock();
            let connected: HashSet<String> =
                inner.clients.values().map(|c| c.device_key.clone()).collect();
            let id = inner.identity.as_ref().map(|i| i.public.clone()).unwrap_or_default();
            (inner.notify, inner.hide_names, connected, id)
        };
        if !notify {
            return;
        }
        let tokens: Vec<String> = self.with_push(app, |t| {
            t.iter()
                .filter(|(key, _)| !connected.contains(*key))
                .map(|(_, target)| target.token.clone())
                .collect()
        });
        if tokens.is_empty() {
            return;
        }
        let notice = word_notice(&kind, &project_name, event, hide, &desktop_id, &project_id);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let gone = push::send(tokens, notice).await;
            if !gone.is_empty() {
                let hub = app.state::<RemoteHub>();
                hub.with_push(&app, |t| t.retain(|_, v| !gone.contains(&v.token)));
                let targets = hub.with_push(&app, |t| t.clone());
                push::save(&app, &targets);
            }
        });
    }

    fn set_relay_state(&self, app: &AppHandle, connected: bool, error: Option<String>) {
        if let Some(relay) = self.inner.lock().relay.as_mut() {
            relay.connected = connected;
            relay.error = error;
        }
        self.changed(app);
    }

    fn save_devices(&self, app: &AppHandle) {
        let devices = self.with_devices(app, |d| d.clone());
        let _ = identity::save_devices(app, &devices);
    }

    fn add_client(&self, app: &AppHandle, device_key: String, hello: &Hello, link: Link) -> u64 {
        let Link { addr, via, tx, kick } = link;
        let id = {
            let mut inner = self.inner.lock();
            inner.next_id += 1;
            let id = inner.next_id;
            inner.clients.insert(
                id,
                Client {
                    device_key,
                    name: hello.name.clone(),
                    platform: hello.platform.clone(),
                    addr,
                    via,
                    app_version: hello.app.clone(),
                    tx,
                    kick,
                    attached: HashSet::new(),
                    connected_at: now_ms(),
                },
            );
            id
        };
        self.connected.fetch_add(1, Ordering::Relaxed);
        self.changed(app);
        id
    }

    fn remove_client(&self, app: &AppHandle, id: u64) {
        if self.inner.lock().clients.remove(&id).is_some() {
            self.connected.fetch_sub(1, Ordering::Relaxed);
        }
        // Whatever it had sized for its screen goes back to the desktop.
        if let Some(mgr) = app.try_state::<PtyManager>() {
            for tab in mgr.release_client(id) {
                crate::pty::emit_size_owner(app, &tab, false);
            }
        }
        self.changed(app);
    }

    fn set_attached(&self, client: u64, tab: &str, attached: bool) {
        if let Some(c) = self.inner.lock().clients.get_mut(&client) {
            if attached {
                c.attached.insert(tab.to_string());
            } else {
                c.attached.remove(tab);
            }
        }
    }

    fn send_to(&self, client: u64, msg: String) {
        if let Some(c) = self.inner.lock().clients.get(&client) {
            c.send(msg);
        }
    }

    /// Sends an event to every client attached to `tab`, built only if any is.
    fn send_to_attached(&self, tab: &str, build: impl Fn(u64) -> String) {
        let inner = self.inner.lock();
        for (id, c) in inner.clients.iter().filter(|(_, c)| c.attached.contains(tab)) {
            c.send(build(*id));
        }
    }

    fn broadcast(&self, msg: String) {
        let inner = self.inner.lock();
        for c in inner.clients.values() {
            c.send(msg.clone());
        }
    }

    /// Tells the settings screen to refresh.
    fn changed(&self, app: &AppHandle) {
        let _ = app.emit("remote://changed", ());
    }

    /// Hands a request to the frontend and waits for its answer.
    async fn forward_to_frontend(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let (id, rx) = {
            let mut inner = self.inner.lock();
            inner.next_id += 1;
            let id = inner.next_id;
            let (tx, rx) = oneshot::channel();
            inner.commands.insert(id, tx);
            (id, rx)
        };
        let _ = app.emit(
            "remote://command",
            json!({ "requestId": id, "method": method, "params": params }),
        );
        let result = tokio::time::timeout(COMMAND_TIMEOUT, rx).await;
        self.inner.lock().commands.remove(&id);
        match result {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("the desktop dropped the request".into()),
            Err(_) => Err("the desktop did not answer in time".into()),
        }
    }
}

/// Compares secrets without stopping at the first difference.
fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn event(name: &str, data: Value) -> String {
    json!({ "t": "ev", "e": name, "d": data }).to_string()
}

fn event_msg(name: &str, data: Value) -> String {
    event(name, data)
}

/// The notification for an agent event, in as few words as a lock screen fits.
fn word_notice(
    kind: &str,
    project: &str,
    e: &agent_events::AgentEvent,
    hide: bool,
    desktop_id: &str,
    project_id: &str,
) -> push::Notice {
    use agent_events::AgentKind;
    let who = push::harness_label(kind);
    let detail = e.message.as_deref().filter(|_| !hide);
    let body = match (e.kind, detail) {
        (AgentKind::Permission, Some(m)) => m.to_string(),
        (AgentKind::Permission, None) => format!("{who} needs your permission"),
        (AgentKind::NeedsInput, _) => format!("{who} is waiting for you"),
        (AgentKind::Finished, Some(m)) => format!("{who} finished: {}", m.chars().take(140).collect::<String>()),
        (AgentKind::Finished, None) => format!("{who} finished"),
    };
    let title = if hide || project.is_empty() { "AlmaStudio".to_string() } else { project.to_string() };
    push::Notice {
        title,
        body,
        data: json!({ "desktopId": desktop_id, "projectId": project_id, "tabId": e.tab_id }),
    }
}

// ---------------------------------------------------------------------------
// Hooks called from the pty threads
// ---------------------------------------------------------------------------

fn hub(app: &AppHandle) -> Option<tauri::State<'_, RemoteHub>> {
    let hub = app.try_state::<RemoteHub>()?;
    (hub.connected.load(Ordering::Relaxed) > 0).then_some(hub)
}

pub fn on_pty_data(app: &AppHandle, id: &str, b64: &str, end: u64) {
    let Some(hub) = hub(app) else { return };
    let msg = event("term.data", json!({ "tabId": id, "b64": b64, "end": end }));
    hub.send_to_attached(id, |_| msg.clone());
}

pub fn on_pty_exit(app: &AppHandle, id: &str, code: i32) {
    let Some(hub) = hub(app) else { return };
    hub.broadcast(event("term.exit", json!({ "tabId": id, "code": code })));
}

pub fn on_activity(app: &AppHandle, id: &str, busy: bool) {
    agent_events::on_activity(app, id, busy);
    let Some(hub) = hub(app) else { return };
    hub.broadcast(event("activity", json!({ "tabId": id, "busy": busy })));
}

pub fn on_size_owner(app: &AppHandle, id: &str) {
    let Some(hub) = hub(app) else { return };
    let owner = app.try_state::<PtyManager>().and_then(|m| m.size_owner(id));
    hub.send_to_attached(id, |client| {
        event(
            "term.owner",
            json!({ "tabId": id, "remote": owner.is_some(), "mine": owner == Some(client) }),
        )
    });
}

// ---------------------------------------------------------------------------
// Commands for the desktop UI
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    id: u64,
    device_key: String,
    name: String,
    platform: String,
    addr: String,
    via: &'static str,
    app_version: String,
    attached: Vec<String>,
    connected_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    running: bool,
    port: Option<u16>,
    error: Option<String>,
    addresses: Vec<String>,
    relay: Option<RelayStatus>,
    clients: Vec<ClientInfo>,
    devices: Vec<Device>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    url: String,
    connected: bool,
    error: Option<String>,
}

/// This machine's private IPv4 addresses, where a phone on the same network
/// can reach it.
fn lan_addresses() -> Vec<String> {
    let Ok(ifaces) = local_ip_address::list_afinet_netifas() else { return Vec::new() };
    let mut out: Vec<String> = ifaces
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(v4) if v4.is_private() => Some(v4.to_string()),
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn status(app: &AppHandle, hub: &RemoteHub) -> RemoteStatus {
    let devices = hub.with_devices(app, |d| d.clone());
    let inner = hub.inner.lock();
    let mut clients: Vec<ClientInfo> = inner
        .clients
        .iter()
        .map(|(id, c)| ClientInfo {
            id: *id,
            device_key: c.device_key.clone(),
            name: c.name.clone(),
            platform: c.platform.clone(),
            addr: c.addr.clone(),
            via: c.via,
            app_version: c.app_version.clone(),
            attached: c.attached.iter().cloned().collect(),
            connected_at: c.connected_at,
        })
        .collect();
    clients.sort_by_key(|c| c.id);
    RemoteStatus {
        running: inner.server.is_some(),
        port: inner.server.as_ref().map(|s| s.port),
        error: inner.error.clone(),
        addresses: if inner.server.is_some() { lan_addresses() } else { Vec::new() },
        relay: inner.relay.as_ref().map(|r| RelayStatus {
            url: r.url.clone(),
            connected: r.connected,
            error: r.error.clone(),
        }),
        clients,
        devices,
    }
}

fn stop_server(inner: &mut Inner) {
    if let Some(server) = inner.server.take() {
        let _ = server.shutdown.send(true);
    }
    stop_relay(inner);
}

fn stop_relay(inner: &mut Inner) {
    if let Some(relay) = inner.relay.take() {
        let _ = relay.shutdown.send(true);
    }
    inner.relay_url = None;
}

#[derive(Deserialize)]
pub struct RelayConfig {
    url: String,
}

/// Starts, restarts or stops the server — and the relay connection — to
/// match the settings.
#[tauri::command]
pub async fn remote_configure(
    app: AppHandle,
    enabled: bool,
    port: u16,
    name: String,
    relay: Option<RelayConfig>,
    notify: Option<bool>,
    hide_names: Option<bool>,
) -> Result<RemoteStatus, String> {
    let hub = app.state::<RemoteHub>();
    let port = if port == 0 { DEFAULT_PORT } else { port };
    let relay_url = relay
        .map(|r| r.url.trim().to_string())
        .filter(|u| enabled && (u.starts_with("wss://") || u.starts_with("ws://")));
    let start_server = {
        let mut inner = hub.inner.lock();
        inner.name = name;
        inner.notify = notify.unwrap_or(true);
        inner.hide_names = hide_names.unwrap_or(false);
        let running_on = inner.server.as_ref().map(|s| s.port);
        if !(enabled && running_on == Some(port)) {
            // Stopping the server stops the relay too; it is restarted below.
            stop_server(&mut inner);
            inner.error = None;
            enabled
        } else {
            false
        }
    };
    if start_server {
        hub.identity(&app).map_err(|e| e.to_string())?;
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(listener) => {
                let (tx, rx) = watch::channel(false);
                hub.inner.lock().server = Some(ServerHandle { port, shutdown: tx });
                tauri::async_runtime::spawn(server::run(app.clone(), listener, rx));
            }
            Err(e) => {
                hub.inner.lock().error = Some(format!("port {port}: {e}"));
            }
        }
    }
    {
        let mut inner = hub.inner.lock();
        let current = inner.relay.as_ref().map(|r| r.url.clone());
        if current != relay_url {
            stop_relay(&mut inner);
            if let Some(url) = relay_url {
                let (tx, rx) = watch::channel(false);
                inner.relay = Some(RelayHandle {
                    url: url.clone(),
                    shutdown: tx,
                    connected: false,
                    error: None,
                });
                inner.relay_url = Some(url.clone());
                tauri::async_runtime::spawn(relay_client::run(app.clone(), url, rx));
            }
        }
    }
    hub.changed(&app);
    Ok(status(&app, &hub))
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> RemoteStatus {
    let hub = app.state::<RemoteHub>();
    status(&app, &hub)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// What the QR code holds; also opens the app when tapped on the phone.
    uri: String,
    svg: String,
    expires_at: u64,
}

/// Issues a fresh one-time pairing code, replacing any earlier one.
#[tauri::command]
pub fn remote_pairing(app: AppHandle, relay: Option<String>) -> Result<PairingInfo, String> {
    let hub = app.state::<RemoteHub>();
    let identity = hub.identity(&app).map_err(|e| e.to_string())?;
    let mut token = [0u8; 16];
    getrandom::fill(&mut token).map_err(|e| e.to_string())?;
    let token = b64url(&token);
    let (port, name) = {
        let mut inner = hub.inner.lock();
        let Some(port) = inner.server.as_ref().map(|s| s.port) else {
            return Err("Remote access is off".into());
        };
        inner.pairing = Some(Pairing { token: token.clone(), expires: Instant::now() + PAIRING_TTL });
        (port, inner.name.clone())
    };
    let addrs: Vec<String> = lan_addresses().into_iter().map(|a| format!("{a}:{port}")).collect();
    let payload = json!({
        "v": 1,
        "n": name,
        "k": identity.public,
        "a": addrs,
        "t": token,
        "r": relay,
    });
    let uri = format!("almastudio://pair?d={}", b64url(payload.to_string().as_bytes()));
    let svg = qrcode::QrCode::with_error_correction_level(uri.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    let expires_at = now_ms() + PAIRING_TTL.as_millis() as u64;
    Ok(PairingInfo { uri, svg, expires_at })
}

/// The user's answer to "allow this device?".
#[tauri::command]
pub fn remote_pair_respond(app: AppHandle, request_id: u64, accept: bool) {
    let hub = app.state::<RemoteHub>();
    let pending = hub.inner.lock().pair_requests.remove(&request_id);
    if let Some(tx) = pending {
        let _ = tx.send(accept);
    }
}

/// Forgets a paired device and disconnects it.
#[tauri::command]
pub fn remote_revoke(app: AppHandle, key: String) {
    let hub = app.state::<RemoteHub>();
    hub.with_devices(&app, |d| d.retain(|d| d.key != key));
    hub.save_devices(&app);
    hub.with_push(&app, |t| t.remove(&key));
    let targets = hub.with_push(&app, |t| t.clone());
    push::save(&app, &targets);
    for c in hub.inner.lock().clients.values().filter(|c| c.device_key == key) {
        c.kick.notify_one();
    }
    hub.changed(&app);
}

/// The frontend's summary of projects and tabs, pushed to every client.
#[tauri::command]
pub fn remote_publish_state(app: AppHandle, state: Value) {
    let hub = app.state::<RemoteHub>();
    hub.inner.lock().workspace = state.clone();
    if hub.connected.load(Ordering::Relaxed) > 0 {
        hub.broadcast(event("workspace", state));
    }
}

/// The frontend's answer to a forwarded command.
#[tauri::command]
pub fn remote_command_result(
    app: AppHandle,
    request_id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) {
    let hub = app.state::<RemoteHub>();
    let pending = hub.inner.lock().commands.remove(&request_id);
    if let Some(tx) = pending {
        let _ = tx.send(if ok {
            Ok(result.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "failed".into()))
        });
    }
}

impl RemoteHub {
    /// Records where to push for the device behind `client`.
    fn register_push(&self, app: &AppHandle, client: u64, target: Option<push::PushTarget>) -> Result<(), String> {
        let key = self
            .inner
            .lock()
            .clients
            .get(&client)
            .map(|c| c.device_key.clone())
            .ok_or("not connected")?;
        let targets = self.with_push(app, |t| {
            match target {
                Some(target) => {
                    t.insert(key, target);
                }
                None => {
                    t.remove(&key);
                }
            }
            t.clone()
        });
        push::save(app, &targets);
        Ok(())
    }
}

/// Stops the server and drops every client; called on exit.
pub fn shutdown(app: &AppHandle) {
    if let Some(hub) = app.try_state::<RemoteHub>() {
        stop_server(&mut hub.inner.lock());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_eq_compares_whole_strings() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "ab"));
        assert!(!constant_eq("", "a"));
    }
}
