//! The desktop's long-term key and the list of devices paired with it.
//!
//! Both live under `state/remote/`. The private key never leaves this machine:
//! the pairing QR code carries only the public half. Revoking a device removes
//! its key, after which its handshakes fail.

use std::fs;
use std::path::PathBuf;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::store::{atomic_write, state_dir};

use super::noise;

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_b64url(s: &str) -> anyhow::Result<Vec<u8>> {
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('='))?)
}

fn remote_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = state_dir(app)?.join("remote");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    /// base64url X25519 keys.
    pub private: String,
    pub public: String,
}

impl Identity {
    pub fn private_bytes(&self) -> anyhow::Result<Vec<u8>> {
        from_b64url(&self.private)
    }
}

/// Loads the desktop's key, creating it on first use.
pub fn load_or_create_identity(app: &AppHandle) -> anyhow::Result<Identity> {
    let path = remote_dir(app)?.join("identity.json");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(id) = serde_json::from_str::<Identity>(&text) {
            return Ok(id);
        }
    }
    let (private, public) = noise::generate_keypair()?;
    let id = Identity { private: b64url(&private), public: b64url(&public) };
    atomic_write(&path, serde_json::to_string_pretty(&id)?.as_bytes())?;
    restrict_permissions(&path);
    Ok(id)
}

/// Only the user may read the key file.
fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// base64url of the device's static public key; its identity.
    pub key: String,
    pub name: String,
    pub platform: String,
    pub paired_at: u64,
    pub last_seen: u64,
}

pub fn load_devices(app: &AppHandle) -> Vec<Device> {
    let Ok(dir) = remote_dir(app) else { return Vec::new() };
    fs::read_to_string(dir.join("devices.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_devices(app: &AppHandle, devices: &[Device]) -> anyhow::Result<()> {
    let path = remote_dir(app)?.join("devices.json");
    atomic_write(&path, serde_json::to_string_pretty(devices)?.as_bytes())
}
