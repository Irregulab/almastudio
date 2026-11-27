//! The requests sent to Claude Code from each tab, for the list of them above
//! the terminal.
//!
//! The tab's UserPromptSubmit hook appends its input to the tab's events file
//! as the other hooks do (see `harness.ts`), and `remote::agent_events` hands
//! each such line here. Each request is kept as one JSON line in
//! `state/prompts/<tab>.jsonl` — the events file is only read from where it
//! ended when the app started, so it cannot be the history itself — and the
//! app is told at once, so an open list grows as requests are sent.
//!
//! A conversation started over — after /clear, or on a fresh start — takes
//! its requests with it, and the messages pinned to the tab: the tab's
//! SessionStart hook writes to the events file too, and says why it fired.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// How much of one request is kept.
const MAX_PROMPT_CHARS: usize = 20_000;
/// How many requests a tab keeps; older ones are dropped.
pub const MAX_PROMPTS: usize = 500;
/// Past this the file is cut back, to half of it at most.
const TRIM_AT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentPrompt {
    pub text: String,
    /// When it was sent, in ms.
    pub at: u64,
    /// The Claude Code session it was sent in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptPayload<'a> {
    tab_id: &'a str,
    prompt: &'a SentPrompt,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetPayload<'a> {
    tab_id: &'a str,
}

/// Whether a SessionStart hook's input begins a new conversation: one
/// started afresh or after /clear, and not one resumed or compacted. None
/// for any other line.
pub fn session_start(line: &str) -> Option<bool> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("hook_event_name").and_then(Value::as_str) != Some("SessionStart") {
        return None;
    }
    Some(matches!(v.get("source").and_then(Value::as_str), Some("startup" | "clear")))
}

/// The request a UserPromptSubmit hook's input carries, sent at `at`; None for
/// any other line.
pub fn parse(line: &str, at: u64) -> Option<SentPrompt> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("hook_event_name").and_then(Value::as_str) != Some("UserPromptSubmit") {
        return None;
    }
    let text = v.get("prompt").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(SentPrompt {
        text: text.chars().take(MAX_PROMPT_CHARS).collect(),
        at,
        session: v.get("session_id").and_then(Value::as_str).map(String::from),
    })
}

pub(crate) fn prompts_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(crate::store::state_dir(app)?.join("prompts"))
}

fn file_for(dir: &Path, tab_id: &str) -> PathBuf {
    dir.join(format!("{}.jsonl", crate::store::safe_key(tab_id)))
}

/// Keeps a request sent from `tab_id`, and tells the app.
pub fn record(app: &AppHandle, tab_id: &str, prompt: &SentPrompt) {
    if let Ok(dir) = prompts_dir(app) {
        // Best-effort: a request missing from the list is no reason to fail.
        let _ = append(&file_for(&dir, tab_id), prompt);
    }
    let _ = app.emit("agent://prompt", PromptPayload { tab_id, prompt });
}

/// Forgets the requests sent from a tab whose conversation started over, and
/// tells the app, which unpins its messages.
pub fn forget(app: &AppHandle, tab_id: &str) {
    if let Ok(dir) = prompts_dir(app) {
        let _ = fs::remove_file(file_for(&dir, tab_id));
    }
    let _ = app.emit("agent://conversation-reset", ResetPayload { tab_id });
}

fn append(path: &Path, prompt: &SentPrompt) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_string(prompt)?;
    line.push('\n');
    let len = {
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(line.as_bytes())?;
        f.metadata()?.len() as usize
    };
    if len > TRIM_AT_BYTES {
        trim(path)?;
    }
    Ok(())
}

/// Cuts the file back to its latest requests: `MAX_PROMPTS` of them, in half
/// the size that set it off, so the next request does not set it off again.
fn trim(path: &Path) -> anyhow::Result<()> {
    let text = fs::read_to_string(path)?;
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in text.lines().rev().filter(|l| !l.trim().is_empty()) {
        if kept.len() == MAX_PROMPTS || size + line.len() + 1 > TRIM_AT_BYTES / 2 {
            break;
        }
        size += line.len() + 1;
        kept.push(line);
    }
    let mut out = String::with_capacity(size);
    for line in kept.iter().rev() {
        out.push_str(line);
        out.push('\n');
    }
    // A request appended meanwhile would be lost: there is none, as hook
    // lines are read one after another.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, out)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// The latest `MAX_PROMPTS` requests in the file, oldest first; none when
/// there is no file.
fn read(path: &Path) -> Vec<SentPrompt> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    let mut all: Vec<SentPrompt> =
        text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let cut = all.len().saturating_sub(MAX_PROMPTS);
    all.drain(..cut);
    all
}

/// The requests sent from a tab, oldest first.
#[tauri::command]
pub fn prompt_history(app: AppHandle, id: String) -> Result<Vec<SentPrompt>, String> {
    let dir = prompts_dir(&app).map_err(|e| e.to_string())?;
    Ok(read(&file_for(&dir, &id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(text: &str, at: u64) -> SentPrompt {
        SentPrompt { text: text.into(), at, session: None }
    }

    #[test]
    fn reads_the_request_from_a_user_prompt_submit_hook() {
        let line = r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"  fix the tests\nplease  "}"#;
        assert_eq!(
            parse(line, 7),
            Some(SentPrompt { text: "fix the tests\nplease".into(), at: 7, session: Some("s1".into()) }),
        );
    }

    #[test]
    fn leaves_other_hooks_and_empty_requests_alone() {
        assert_eq!(parse(r#"{"hook_event_name":"Stop"}"#, 1), None);
        assert_eq!(parse(r#"{"hook_event_name":"UserPromptSubmit","prompt":"   "}"#, 1), None);
        assert_eq!(parse(r#"{"hook_event_name":"UserPromptSubmit"}"#, 1), None);
        assert_eq!(parse("not json", 1), None);
    }

    #[test]
    fn tells_a_new_conversation_from_one_that_goes_on() {
        let start = |source: &str| {
            session_start(&format!(r#"{{"hook_event_name":"SessionStart","source":"{source}"}}"#))
        };
        assert_eq!(start("startup"), Some(true));
        assert_eq!(start("clear"), Some(true));
        assert_eq!(start("resume"), Some(false));
        assert_eq!(start("compact"), Some(false));
        assert_eq!(session_start(r#"{"hook_event_name":"SessionStart"}"#), Some(false));
        assert_eq!(session_start(r#"{"hook_event_name":"Stop"}"#), None);
    }

    #[test]
    fn keeps_only_the_start_of_a_huge_request() {
        let long = "é".repeat(MAX_PROMPT_CHARS + 10);
        let line = serde_json::json!({ "hook_event_name": "UserPromptSubmit", "prompt": long }).to_string();
        assert_eq!(parse(&line, 1).unwrap().text.chars().count(), MAX_PROMPT_CHARS);
    }

    #[test]
    fn appends_and_reads_back_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_for(dir.path(), "tab/../1");
        assert!(path.starts_with(dir.path()));
        assert_eq!(read(&path), vec![]);
        append(&path, &prompt("one", 1)).unwrap();
        append(&path, &prompt("two", 2)).unwrap();
        assert_eq!(read(&path), vec![prompt("one", 1), prompt("two", 2)]);
    }

    #[test]
    fn reads_only_the_latest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        for i in 0..(MAX_PROMPTS as u64 + 3) {
            append(&path, &prompt("x", i)).unwrap();
        }
        let got = read(&path);
        assert_eq!(got.len(), MAX_PROMPTS);
        assert_eq!(got[0].at, 3);
    }

    #[test]
    fn trims_a_file_grown_too_big_to_its_latest_requests() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let big = "y".repeat(MAX_PROMPT_CHARS);
        let mut at = 0;
        while fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0) <= TRIM_AT_BYTES / 2 {
            at += 1;
            append(&path, &prompt(&big, at)).unwrap();
        }
        let before = read(&path).len();
        while fs::metadata(&path).unwrap().len() as usize > TRIM_AT_BYTES / 2 {
            at += 1;
            append(&path, &prompt(&big, at)).unwrap();
        }
        let after = read(&path);
        assert!(fs::metadata(&path).unwrap().len() as usize <= TRIM_AT_BYTES / 2);
        assert!(after.len() <= before);
        assert_eq!(after.last().unwrap().at, at);
        // Still in order, with nothing in the middle dropped.
        assert!(after.windows(2).all(|w| w[1].at == w[0].at + 1));
    }
}
