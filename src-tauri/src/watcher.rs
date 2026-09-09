//! Filesystem watching that drives the right-hand panel.
//!
//! Refreshes are event-driven rather than polled, so an idle project costs
//! nothing. Events are coalesced over a short window because a single `npm
//! install` or a agent's edit burst can produce thousands of them, and the
//! panel only needs to know *that* something changed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Events are collected for this long before one notification is emitted.
const DEBOUNCE_MS: u64 = 350;
/// Paths listed in the payload; the frontend only uses them for logging.
const MAX_REPORTED_PATHS: usize = 40;

/// Directory names that generate huge amounts of churn and never need to be
/// reflected in the panel.
const NOISY_DIRS: &[&str] = &[
    "node_modules",
    ".git/objects",
    ".git/lfs",
    "target/debug",
    "target/release",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".gradle",
    ".cargo",
    "vendor/bundle",
];

fn is_noise(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.ends_with("~") || s.ends_with(".swp") || s.ends_with(".tmp") || s.ends_with("/.DS_Store") {
        return true;
    }
    NOISY_DIRS.iter().any(|d| s.contains(&format!("/{d}/")) || s.ends_with(&format!("/{d}")))
}

/// `.git` writes that matter (a commit, a branch switch, a staging operation)
/// versus internal churn we already filtered out above.
fn is_git_meta(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    s.contains("/.git/")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePayload {
    pub id: String,
    pub paths: Vec<String>,
    /// True when the change touched git metadata (commit, checkout, staging).
    pub git_meta: bool,
    pub count: usize,
}

struct Handle {
    // Dropping the watcher stops the OS subscription, which closes the channel
    // and lets the debounce thread exit on its own.
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct WatchManager {
    watches: Mutex<HashMap<String, Handle>>,
}

impl WatchManager {
    pub fn stop(&self, id: &str) {
        self.watches.lock().remove(id);
    }

    pub fn stop_all(&self) {
        self.watches.lock().clear();
    }

    pub fn start(&self, app: &AppHandle, id: String, path: String) -> anyhow::Result<()> {
        // Re-watching the same id replaces the previous subscription.
        self.watches.lock().remove(&id);

        let root = PathBuf::from(&path);
        if !root.is_dir() {
            anyhow::bail!("not a directory: {path}");
        }

        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                // A closed receiver just means the watch was stopped.
                let _ = tx.send(res);
            },
            Config::default(),
        )?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let app = app.clone();
        let event_name = format!("fs://changed/{id}");
        let watch_id = id.clone();
        thread::spawn(move || {
            loop {
                // Block with no timeout: an idle project burns zero CPU.
                let first = match rx.recv() {
                    Ok(ev) => ev,
                    Err(_) => break, // watcher dropped
                };

                let mut paths: Vec<String> = Vec::new();
                let mut git_meta = false;
                let mut count = 0usize;

                let absorb = |ev: notify::Result<Event>,
                                  paths: &mut Vec<String>,
                                  git_meta: &mut bool,
                                  count: &mut usize| {
                    let Ok(ev) = ev else { return };
                    for p in ev.paths {
                        if is_noise(&p) {
                            continue;
                        }
                        if is_git_meta(&p) {
                            *git_meta = true;
                        }
                        *count += 1;
                        if paths.len() < MAX_REPORTED_PATHS {
                            paths.push(p.to_string_lossy().to_string());
                        }
                    }
                };

                absorb(first, &mut paths, &mut git_meta, &mut count);

                // Coalesce everything that lands inside the debounce window.
                let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
                loop {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(ev) => absorb(ev, &mut paths, &mut git_meta, &mut count),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }

                if count == 0 {
                    continue;
                }
                let payload = ChangePayload { id: watch_id.clone(), paths, git_meta, count };
                if app.emit(&event_name, payload).is_err() {
                    break;
                }
            }
        });

        self.watches.lock().insert(id, Handle { _watcher: watcher });
        Ok(())
    }
}

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    mgr: tauri::State<'_, WatchManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    mgr.start(&app, id, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watch_stop(mgr: tauri::State<'_, WatchManager>, id: String) {
    mgr.stop(&id);
}
