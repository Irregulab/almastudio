//! On-disk state: settings, the workspace (projects + tabs + layout) and the
//! per-tab scrollback tails used to restore tabs after a restart.
//!
//! Everything here is written to survive an unclean shutdown — a `kill -9`, a
//! power cut or a machine reboot must never leave the user with an empty
//! project list. The scheme is: write to a temp file, fsync it, rotate the
//! current file to `.bak` and rename the temp into place. Both renames are
//! atomic, so a crash at any instant leaves at least one readable file, and the
//! loader prefers the primary and silently falls back to the backup.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::pty::PtyManager;

/// How often dirty scrollback rings are written out.
const SCROLLBACK_FLUSH_SECS: u64 = 5;

fn state_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("state");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn scrollback_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = state_dir(app)?.join("scrollback");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// One record per Claude Code tab, written by the tab's own SessionStart hook
/// (see `claudeSessionSettings` in the frontend), naming the session it is on.
/// Not created here: the hook creates it on first use.
fn sessions_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(state_dir(app)?.join("sessions"))
}

/// Tab ids come from the frontend, so never let one escape its directory.
fn safe_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned.chars().take(96).collect()
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow::anyhow!("no parent dir"))?;
    fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");

    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    let bak = path.with_extension("bak");
    if path.exists() {
        let _ = fs::remove_file(&bak);
        // Atomic: the previous good copy is never lost, only renamed.
        let _ = fs::rename(path, &bak);
    }
    fs::rename(&tmp, path)?;

    // Durably record the directory entries too, otherwise the renames may still
    // be in the page cache when the machine loses power.
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn read_first_valid(primary: &Path, backup: &Path) -> Option<String> {
    for p in [primary, backup] {
        if let Ok(s) = fs::read_to_string(p) {
            if serde_json::from_str::<serde_json::Value>(&s).is_ok() {
                return Some(s);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Key/value JSON blobs — the frontend owns the schema
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn state_load(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let dir = state_dir(&app).map_err(|e| e.to_string())?;
    let key = safe_key(&key);
    let primary = dir.join(format!("{key}.json"));
    let backup = dir.join(format!("{key}.bak"));
    Ok(read_first_valid(&primary, &backup))
}

#[tauri::command]
pub fn state_save(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Refuse to persist anything that would not load back.
    serde_json::from_str::<serde_json::Value>(&value)
        .map_err(|e| format!("refusing to save invalid JSON for {key}: {e}"))?;
    let dir = state_dir(&app).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", safe_key(&key)));
    atomic_write(&path, value.as_bytes()).map_err(|e| e.to_string())
}

/// Where the state lives, so the Settings panel can show and reveal it.
#[tauri::command]
pub fn state_dir_path(app: AppHandle) -> Result<String, String> {
    state_dir(&app)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Scrollback
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scrollback {
    pub b64: String,
    /// Stream offset this snapshot ends at. Only meaningful when `live`.
    pub end: u64,
    /// True when it came from a session that is still running, in which case
    /// the caller must discard incoming batches ending at or before `end`.
    pub live: bool,
}

/// Returns the retained output for a tab: the live ring if the session is
/// still running, otherwise the tail persisted before the last exit.
#[tauri::command]
pub fn scrollback_load(
    app: AppHandle,
    mgr: tauri::State<'_, PtyManager>,
    id: String,
) -> Result<Scrollback, String> {
    let engine = base64::engine::general_purpose::STANDARD;
    if let Some(ring) = mgr.ring_of(&id) {
        let guard = ring.lock();
        return Ok(Scrollback {
            b64: engine.encode(guard.snapshot()),
            end: guard.total(),
            live: true,
        });
    }
    let dir = scrollback_dir(&app).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.bin", safe_key(&id)));
    Ok(Scrollback {
        b64: fs::read(path).map(|b| engine.encode(b)).unwrap_or_default(),
        end: 0,
        live: false,
    })
}

/// Drops scrollback, and Claude session records, for tabs the workspace no
/// longer contains.
#[tauri::command]
pub fn scrollback_prune(app: AppHandle, keep: Vec<String>) -> Result<(), String> {
    let dir = scrollback_dir(&app).map_err(|e| e.to_string())?;
    prune_dir(&dir, "bin", &keep);
    if let Ok(dir) = sessions_dir(&app) {
        prune_dir(&dir, "json", &keep);
    }
    Ok(())
}

/// Removes every file in `dir` other than `<key>.<ext>` for the kept tab ids.
fn prune_dir(dir: &Path, ext: &str, keep: &[String]) {
    let keep: Vec<String> = keep.iter().map(|k| format!("{}.{ext}", safe_key(k))).collect();
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep.contains(&name) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub fn scrollback_forget(app: AppHandle, id: String) -> Result<(), String> {
    let dir = scrollback_dir(&app).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join(format!("{}.bin", safe_key(&id))));
    if let Ok(dir) = sessions_dir(&app) {
        let _ = fs::remove_file(dir.join(format!("{}.json", safe_key(&id))));
    }
    Ok(())
}

/// Writes every dirty ring buffer out. Called on a timer and at shutdown.
pub fn flush_scrollback(app: &AppHandle, mgr: &PtyManager) {
    let Ok(dir) = scrollback_dir(app) else { return };
    for id in mgr.ids() {
        let Some(ring) = mgr.ring_of(&id) else { continue };
        let snapshot = { ring.lock().take_if_dirty() };
        if let Some(bytes) = snapshot {
            let path = dir.join(format!("{}.bin", safe_key(&id)));
            // Best-effort: a lost scrollback tail is cosmetic, never fatal.
            let _ = fs::write(path, bytes);
        }
    }
}

/// Background flusher. Sleeps most of the time and does nothing at all when no
/// session has produced output since the last pass.
pub fn spawn_scrollback_flusher(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(SCROLLBACK_FLUSH_SECS));
        let Some(mgr) = app.try_state::<PtyManager>() else { break };
        flush_scrollback(&app, &mgr);
    });
}
