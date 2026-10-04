//! When an agent finishes a turn or waits on the user.
//!
//! Every tab is started with `ALMASTUDIO_EVENTS_FILE` naming
//! `state/events/<tab>.jsonl`. Claude Code's Notification and Stop hooks, and
//! Codex's `notify` program, append one JSON line there (see `harness.ts`).
//! This watches the folder, reads what was appended and turns it into an
//! `AgentEvent`: shown in the app when it is connected, pushed to the paired
//! devices that are not.
//!
//! OpenCode has no such hook, so for it a long stretch of output followed by
//! silence counts as a finished turn (`on_activity`).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::RemoteHub;

/// A turn this long, then silence, is a finished turn for harnesses without hooks.
const HEURISTIC_MIN_BUSY: Duration = Duration::from_secs(20);
/// Repeats of the same event for the same tab within this are dropped.
const REPEAT_WINDOW: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    NeedsInput,
    Permission,
    Finished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub tab_id: String,
    pub kind: AgentKind,
    pub message: Option<String>,
}

/// Reads one line a hook appended. None for events nobody needs to hear of.
pub fn parse_line(tab_id: &str, line: &str) -> Option<AgentEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let message = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .map(|s| s.trim().chars().take(240).collect::<String>())
            .filter(|s| !s.is_empty())
    };
    // Claude Code hooks.
    if let Some(name) = v.get("hook_event_name").and_then(Value::as_str) {
        let kind = match name {
            "Stop" => AgentKind::Finished,
            "Notification" => {
                let ty = v.get("notification_type").and_then(Value::as_str).unwrap_or("");
                let text = message("message").unwrap_or_default().to_lowercase();
                match ty {
                    "permission_prompt" => AgentKind::Permission,
                    "idle_prompt" | "elicitation_dialog" => AgentKind::NeedsInput,
                    // Logged in, and the like: nothing to act on.
                    "" if text.contains("permission") => AgentKind::Permission,
                    "" => AgentKind::NeedsInput,
                    _ => return None,
                }
            }
            _ => return None,
        };
        return Some(AgentEvent { tab_id: tab_id.into(), kind, message: message("message") });
    }
    // Codex's notify program.
    if v.get("type").and_then(Value::as_str) == Some("agent-turn-complete") {
        return Some(AgentEvent {
            tab_id: tab_id.into(),
            kind: AgentKind::Finished,
            message: message("last-assistant-message"),
        });
    }
    None
}

#[derive(Default)]
pub struct AgentEvents {
    offsets: Mutex<HashMap<PathBuf, u64>>,
    last: Mutex<HashMap<(String, AgentKind), Instant>>,
    busy_since: Mutex<HashMap<String, Instant>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Starts watching the events folder.
pub fn start(app: &AppHandle) {
    let Ok(dir) = crate::store::state_dir(app).map(|d| d.join("events")) else { return };
    let _ = fs::create_dir_all(&dir);
    let state = app.state::<AgentEvents>();
    // Whatever is there already happened before this run.
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut offsets = state.offsets.lock();
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                offsets.insert(e.path(), meta.len());
            }
        }
    }
    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        for path in event.paths {
            if path.extension().is_some_and(|e| e == "jsonl") {
                read_new(&handle, &path);
            }
        }
    });
    if let Ok(mut w) = watcher {
        if w.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
            *state.watcher.lock() = Some(w);
        }
    }
}

fn read_new(app: &AppHandle, path: &Path) {
    let state = app.state::<AgentEvents>();
    let Some(tab_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { return };
    let text = {
        let mut offsets = state.offsets.lock();
        let at = offsets.get(path).copied().unwrap_or(0);
        let Ok(mut f) = fs::File::open(path) else { return };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        // Truncated or replaced: start over.
        let at = if len < at { 0 } else { at };
        if f.seek(SeekFrom::Start(at)).is_err() {
            return;
        }
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() {
            return;
        }
        // Only whole lines; a line still being written is read next time.
        let complete = buf.rfind('\n').map(|i| i + 1).unwrap_or(0);
        offsets.insert(path.to_path_buf(), at + complete as u64);
        buf.truncate(complete);
        buf
    };
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        if let Some(event) = parse_line(&tab_id, line) {
            dispatch(app, event);
        }
    }
}

/// Busy/idle transitions, for harnesses whose turns have no hook.
pub fn on_activity(app: &AppHandle, tab_id: &str, busy: bool) {
    let Some(state) = app.try_state::<AgentEvents>() else { return };
    if busy {
        state.busy_since.lock().entry(tab_id.to_string()).or_insert_with(Instant::now);
        return;
    }
    let Some(since) = state.busy_since.lock().remove(tab_id) else { return };
    if since.elapsed() < HEURISTIC_MIN_BUSY {
        return;
    }
    let hub = app.state::<RemoteHub>();
    if hub.tab_kind(tab_id).as_deref() == Some("opencode") {
        dispatch(app, AgentEvent { tab_id: tab_id.into(), kind: AgentKind::Finished, message: None });
    }
}

fn dispatch(app: &AppHandle, event: AgentEvent) {
    let state = app.state::<AgentEvents>();
    {
        let mut last = state.last.lock();
        let key = (event.tab_id.clone(), event.kind);
        if last.get(&key).is_some_and(|t| t.elapsed() < REPEAT_WINDOW) {
            return;
        }
        last.insert(key, Instant::now());
    }
    let _ = app.emit("agent://event", &event);
    app.state::<RemoteHub>().on_agent_event(app, &event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_hooks() {
        let stop = r#"{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false}"#;
        assert_eq!(parse_line("t", stop).unwrap().kind, AgentKind::Finished);

        let perm = r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}"#;
        let e = parse_line("t", perm).unwrap();
        assert_eq!(e.kind, AgentKind::Permission);
        assert_eq!(e.message.as_deref(), Some("Claude needs your permission to use Bash"));

        let idle = r#"{"hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#;
        assert_eq!(parse_line("t", idle).unwrap().kind, AgentKind::NeedsInput);

        // Older versions send no type; the message tells.
        let old = r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Edit"}"#;
        assert_eq!(parse_line("t", old).unwrap().kind, AgentKind::Permission);

        let auth = r#"{"hook_event_name":"Notification","message":"ok","notification_type":"auth_success"}"#;
        assert!(parse_line("t", auth).is_none());
        assert!(parse_line("t", r#"{"hook_event_name":"SubagentStop"}"#).is_none());
    }

    #[test]
    fn reads_codex_notify() {
        let done = r#"{"type":"agent-turn-complete","turn-id":"1","last-assistant-message":"All tests pass."}"#;
        let e = parse_line("t", done).unwrap();
        assert_eq!(e.kind, AgentKind::Finished);
        assert_eq!(e.message.as_deref(), Some("All tests pass."));
    }

    #[test]
    fn ignores_what_it_does_not_know() {
        assert!(parse_line("t", "not json").is_none());
        assert!(parse_line("t", r#"{"type":"something-else"}"#).is_none());
    }
}
