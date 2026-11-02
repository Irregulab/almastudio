//! When an agent finishes a turn or waits on the user — and answering it
//! from a notification.
//!
//! Every tab is started with `ALMASTUDIO_EVENTS_FILE` naming
//! `state/events/<tab>.jsonl`. Claude Code's Notification, Stop and
//! PermissionRequest hooks, and Codex's `notify` program, append one JSON
//! line there (see `harness.ts`). This watches the folder, reads what was
//! appended and turns it into an `AgentEvent`: shown in the app when it is
//! connected, pushed to the paired devices that are not.
//!
//! OpenCode has no such hook, so for it a long stretch of output followed by
//! silence counts as a finished turn (`on_activity`).
//!
//! An event can be answered from its notification — allow or deny a
//! permission prompt, or send a message to an agent at its prompt — and the
//! answer is typed into the tab only while the tab still waits on exactly
//! that: nothing has been typed into it since, from anywhere, and it is the
//! same run of the program (see `pty::InputMark`). A late or repeated answer
//! is refused or ignored rather than typed into whatever is on screen now.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::RemoteHub;
use crate::pty::{InputMark, PtyManager};

/// A turn this long, then silence, is a finished turn for harnesses without hooks.
const HEURISTIC_MIN_BUSY: Duration = Duration::from_secs(20);
/// Repeats of the same event for the same tab within this are dropped.
const REPEAT_WINDOW: Duration = Duration::from_secs(20);
/// A prompt's notification follows its PermissionRequest at once; an older
/// request is one that never showed a prompt — decided by another hook, say.
const ASK_FRESH: Duration = Duration::from_secs(30);
/// Between a reply's text and its Enter, so the program takes the text as
/// typed and the Enter as sending it — as the app's compose sheet does.
const REPLY_ENTER_DELAY: Duration = Duration::from_millis(150);
/// The longest reply typed into a tab.
const REPLY_MAX_CHARS: usize = 4000;

/// Tools whose prompt is a question rather than allow / deny: Enter there
/// picks the first choice, which is not what "Allow" says.
const NOT_DECIDABLE: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    NeedsInput,
    Permission,
    Finished,
}

/// What the event can be answered with from its notification.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Answers {
    None,
    /// A permission prompt: allow or deny.
    Decision,
    /// The agent waits at its prompt: a message for it.
    Reply,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    /// Set when the event is dispatched; an answer names the event by it.
    pub id: u64,
    pub tab_id: String,
    pub kind: AgentKind,
    pub message: Option<String>,
    pub answers: Answers,
}

impl AgentEvent {
    fn new(tab_id: &str, kind: AgentKind, message: Option<String>, answers: Answers) -> Self {
        AgentEvent { id: 0, tab_id: tab_id.into(), kind, message, answers }
    }
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
        let (kind, answers) = match name {
            "Stop" => (AgentKind::Finished, Answers::Reply),
            "Notification" => {
                let ty = v.get("notification_type").and_then(Value::as_str).unwrap_or("");
                let text = message("message").unwrap_or_default().to_lowercase();
                match ty {
                    // Which prompt it is comes from the PermissionRequest
                    // hook before it; see `with_request`.
                    "permission_prompt" => (AgentKind::Permission, Answers::None),
                    "idle_prompt" => (AgentKind::NeedsInput, Answers::Reply),
                    // A form from an MCP server: typing a message into it
                    // would fill it in.
                    "elicitation_dialog" => (AgentKind::NeedsInput, Answers::None),
                    // Logged in, and the like: nothing to act on.
                    "" if text.contains("permission") => (AgentKind::Permission, Answers::None),
                    "" => (AgentKind::NeedsInput, Answers::Reply),
                    _ => return None,
                }
            }
            _ => return None,
        };
        return Some(AgentEvent::new(tab_id, kind, message("message"), answers));
    }
    // Codex's notify program.
    if v.get("type").and_then(Value::as_str) == Some("agent-turn-complete") {
        return Some(AgentEvent::new(
            tab_id,
            AgentKind::Finished,
            message("last-assistant-message"),
            Answers::Reply,
        ));
    }
    None
}

/// What Claude Code is about to ask permission for, from its
/// PermissionRequest hook — the Notification that follows only says that it
/// asks, not what.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub tool: String,
    /// The command, file, address or pattern, when the tool has one.
    pub what: Option<String>,
}

impl Request {
    /// As a notification shows it: `Bash: git push`.
    fn describe(&self) -> String {
        match &self.what {
            Some(what) => format!("{}: {what}", self.tool),
            None => self.tool.clone(),
        }
    }
}

pub fn parse_request(line: &str) -> Option<Request> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("hook_event_name").and_then(Value::as_str) != Some("PermissionRequest") {
        return None;
    }
    let tool = v.get("tool_name").and_then(Value::as_str)?.to_string();
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    let what = match tool.as_str() {
        "Bash" => field("command"),
        "Edit" | "MultiEdit" | "Write" | "Read" => field("file_path").map(|p| {
            let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("");
            relative_to(&p, cwd)
        }),
        "NotebookEdit" => field("notebook_path"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Glob" | "Grep" => field("pattern"),
        _ => None,
    };
    // One line, short enough for a lock screen.
    let what = what
        .map(|w| w.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|w| !w.is_empty())
        .map(|w| if w.chars().count() > 200 { format!("{}…", w.chars().take(200).collect::<String>()) } else { w });
    Some(Request { tool, what })
}

fn relative_to(path: &str, cwd: &str) -> String {
    let cwd = cwd.trim_end_matches(['/', '\\']);
    match path.strip_prefix(cwd) {
        Some(rest) if !cwd.is_empty() && rest.starts_with(['/', '\\']) => rest[1..].to_string(),
        _ => path.to_string(),
    }
}

/// A permission prompt takes its wording and its buttons from the requests
/// made just before it. With more than one pending it is unclear which the
/// screen shows, so it gets none.
fn with_request(mut event: AgentEvent, requests: Vec<Request>) -> AgentEvent {
    match requests.as_slice() {
        [] => {}
        [one] => {
            event.message = Some(one.describe());
            if !NOT_DECIDABLE.contains(&one.tool.as_str()) {
                event.answers = Answers::Decision;
            }
        }
        many => {
            let tools: Vec<&str> = many.iter().map(|r| r.tool.as_str()).collect();
            event.message = Some(tools.join(", "));
        }
    }
    event
}

/// The events of a tab since anything was last typed into it.
#[derive(Debug, Clone)]
struct Run {
    mark: InputMark,
    first: u64,
    last: u64,
    /// The prompt open on screen — a permission, or a form — and whether it
    /// may be answered with allow / deny. A message is not typed into it.
    asking: Option<(u64, bool)>,
    /// What was answered from a notification, so a repeat is not typed twice.
    answered: Option<(u64, &'static str)>,
}

impl Run {
    /// A new event: part of this run when nothing was typed in between.
    fn record(run: Option<Run>, event: &AgentEvent, mark: InputMark) -> Run {
        let mut run = match run {
            Some(r) if r.mark == mark && r.answered.is_none() => Run { last: event.id, ..r },
            _ => Run { mark, first: event.id, last: event.id, asking: None, answered: None },
        };
        match (event.kind, event.answers) {
            (AgentKind::Permission, answers) => {
                run.asking = Some((event.id, answers == Answers::Decision));
            }
            // A form from an MCP server.
            (AgentKind::NeedsInput, Answers::None) => run.asking = Some((event.id, false)),
            (AgentKind::NeedsInput, _) => {}
            // A finished turn has no prompt open.
            (AgentKind::Finished, _) => run.asking = None,
        }
        run
    }
}

/// An answer from a notification.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Allow,
    Deny,
    Reply(String),
}

impl Answer {
    fn name(&self) -> &'static str {
        match self {
            Answer::Allow => "allow",
            Answer::Deny => "deny",
            Answer::Reply(_) => "reply",
        }
    }
}

/// What became of an answer.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Typed into the tab.
    Sent,
    /// The same answer already was; nothing typed again.
    Already,
    /// The tab no longer waits on that event: answered or moved on.
    Stale,
    /// The tab is not running.
    Gone,
    /// A prompt is open — a permission, or a form — that a message would be
    /// typed into.
    Asking,
}

/// What to type for `answer` to the event `event_id` of the tab's current
/// run, or why not.
fn keys_for(run: &Run, event_id: u64, answer: &Answer) -> Result<Vec<u8>, Outcome> {
    if run.answered == Some((event_id, answer.name())) {
        return Err(Outcome::Already);
    }
    if run.answered.is_some() {
        return Err(Outcome::Stale);
    }
    match answer {
        // Enter takes the highlighted choice, which is "Yes" while nothing
        // has been typed since the prompt appeared; Escape is "No".
        Answer::Allow | Answer::Deny => {
            if run.asking != Some((event_id, true)) {
                return Err(Outcome::Stale);
            }
            Ok(if *answer == Answer::Allow { b"\r".to_vec() } else { b"\x1b".to_vec() })
        }
        Answer::Reply(text) => {
            if run.asking.is_some() {
                return Err(Outcome::Asking);
            }
            if event_id < run.first || event_id > run.last {
                return Err(Outcome::Stale);
            }
            Ok(text.as_bytes().to_vec())
        }
    }
}

/// A reply as it can be typed: one line, no control characters.
pub fn reply_text(text: &str) -> Option<String> {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let line = line.trim();
    (!line.is_empty()).then(|| line.chars().take(REPLY_MAX_CHARS).collect())
}

#[derive(Default)]
pub struct AgentEvents {
    offsets: Mutex<HashMap<PathBuf, u64>>,
    last: Mutex<HashMap<(String, AgentKind), Instant>>,
    busy_since: Mutex<HashMap<String, Instant>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Permission requests not yet followed by their prompt, per tab.
    requests: Mutex<HashMap<String, Vec<(Request, Instant)>>>,
    runs: Mutex<HashMap<String, Run>>,
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
        if let Some(request) = parse_request(line) {
            state.requests.lock().entry(tab_id.clone()).or_default().push((request, Instant::now()));
            continue;
        }
        let Some(event) = parse_line(&tab_id, line) else { continue };
        let event = match event.kind {
            AgentKind::Permission => {
                let pending = state.requests.lock().remove(&tab_id).unwrap_or_default();
                let fresh = pending.into_iter().filter(|(_, at)| at.elapsed() < ASK_FRESH);
                with_request(event, fresh.map(|(r, _)| r).collect())
            }
            // The turn is over: whatever was asked during it was answered.
            AgentKind::Finished => {
                state.requests.lock().remove(&tab_id);
                event
            }
            AgentKind::NeedsInput => event,
        };
        dispatch(app, event);
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
        dispatch(app, AgentEvent::new(tab_id, AgentKind::Finished, None, Answers::Reply));
    }
}

fn next_event_id() -> u64 {
    // From the clock, so an id from before a restart is not taken for one now.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let _ = NEXT.compare_exchange(0, super::now_ms(), Ordering::Relaxed, Ordering::Relaxed);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn dispatch(app: &AppHandle, mut event: AgentEvent) {
    let state = app.state::<AgentEvents>();
    let mark = app.state::<PtyManager>().input_mark(&event.tab_id);
    {
        // After an answer from a notification the next prompt or turn often
        // comes within seconds, and is news to someone away from the desk.
        let answered = state.runs.lock().get(&event.tab_id).is_some_and(|r| r.answered.is_some());
        let mut last = state.last.lock();
        let key = (event.tab_id.clone(), event.kind);
        if !answered && last.get(&key).is_some_and(|t| t.elapsed() < REPEAT_WINDOW) {
            return;
        }
        last.insert(key, Instant::now());
    }
    event.id = next_event_id();
    {
        let mut runs = state.runs.lock();
        match mark {
            Some(mark) => {
                let run = Run::record(runs.remove(&event.tab_id), &event, mark);
                runs.insert(event.tab_id.clone(), run);
            }
            None => {
                runs.remove(&event.tab_id);
            }
        }
    }
    let _ = app.emit("agent://event", &event);
    app.state::<RemoteHub>().on_agent_event(app, &event);
}

/// Types `answer` to the event `event_id` into its tab, if the tab still
/// waits on it.
pub fn answer(app: &AppHandle, tab_id: &str, event_id: u64, answer: Answer) -> Outcome {
    let state = app.state::<AgentEvents>();
    let mgr = app.state::<PtyManager>();
    // Held while typing, so two answers arriving together cannot both pass.
    let mut runs = state.runs.lock();
    let Some(mark) = mgr.input_mark(tab_id) else { return Outcome::Gone };
    let Some(run) = runs.get_mut(tab_id) else { return Outcome::Stale };
    let keys = match keys_for(run, event_id, &answer) {
        Ok(keys) => keys,
        Err(outcome) => return outcome,
    };
    if run.mark != mark {
        return Outcome::Stale;
    }
    if mgr.write(tab_id, &keys).is_err() {
        return Outcome::Gone;
    }
    run.answered = Some((event_id, answer.name()));
    if let Answer::Reply(_) = answer {
        // Enter on its own, and only if nothing else was typed meanwhile.
        let typed = mgr.input_mark(tab_id);
        let app = app.clone();
        let tab = tab_id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(REPLY_ENTER_DELAY);
            let mgr = app.state::<PtyManager>();
            if mgr.input_mark(&tab) == typed {
                let _ = mgr.write(&tab, b"\r");
            }
        });
    }
    Outcome::Sent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_hooks() {
        let stop = r#"{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false}"#;
        let e = parse_line("t", stop).unwrap();
        assert_eq!(e.kind, AgentKind::Finished);
        assert_eq!(e.answers, Answers::Reply);

        let perm = r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}"#;
        let e = parse_line("t", perm).unwrap();
        assert_eq!(e.kind, AgentKind::Permission);
        assert_eq!(e.message.as_deref(), Some("Claude needs your permission to use Bash"));
        // Not answerable until a request says what it is about.
        assert_eq!(e.answers, Answers::None);

        let idle = r#"{"hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#;
        let e = parse_line("t", idle).unwrap();
        assert_eq!(e.kind, AgentKind::NeedsInput);
        assert_eq!(e.answers, Answers::Reply);

        let form = r#"{"hook_event_name":"Notification","message":"x","notification_type":"elicitation_dialog"}"#;
        assert_eq!(parse_line("t", form).unwrap().answers, Answers::None);

        // Older versions send no type; the message tells.
        let old = r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Edit"}"#;
        assert_eq!(parse_line("t", old).unwrap().kind, AgentKind::Permission);

        let auth = r#"{"hook_event_name":"Notification","message":"ok","notification_type":"auth_success"}"#;
        assert!(parse_line("t", auth).is_none());
        assert!(parse_line("t", r#"{"hook_event_name":"SubagentStop"}"#).is_none());
        // A request is not an event of its own.
        assert!(parse_line("t", r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#).is_none());
    }

    #[test]
    fn reads_codex_notify() {
        let done = r#"{"type":"agent-turn-complete","turn-id":"1","last-assistant-message":"All tests pass."}"#;
        let e = parse_line("t", done).unwrap();
        assert_eq!(e.kind, AgentKind::Finished);
        assert_eq!(e.message.as_deref(), Some("All tests pass."));
        assert_eq!(e.answers, Answers::Reply);
    }

    #[test]
    fn ignores_what_it_does_not_know() {
        assert!(parse_line("t", "not json").is_none());
        assert!(parse_line("t", r#"{"type":"something-else"}"#).is_none());
        assert!(parse_request(r#"{"hook_event_name":"Stop"}"#).is_none());
    }

    #[test]
    fn says_what_a_request_is_for() {
        let bash = r#"{"hook_event_name":"PermissionRequest","cwd":"/p","tool_name":"Bash","tool_input":{"command":"git push\n  origin main","description":"Push"},"permission_suggestions":[]}"#;
        assert_eq!(parse_request(bash).unwrap().describe(), "Bash: git push origin main");
        let edit = r#"{"hook_event_name":"PermissionRequest","cwd":"/p/","tool_name":"Edit","tool_input":{"file_path":"/p/src/a.rs"}}"#;
        assert_eq!(parse_request(edit).unwrap().describe(), "Edit: src/a.rs");
        let outside = r#"{"hook_event_name":"PermissionRequest","cwd":"/p","tool_name":"Write","tool_input":{"file_path":"/pq/b"}}"#;
        assert_eq!(parse_request(outside).unwrap().describe(), "Write: /pq/b");
        let mcp = r#"{"hook_event_name":"PermissionRequest","tool_name":"mcp__x__y","tool_input":{"a":1}}"#;
        assert_eq!(parse_request(mcp).unwrap().describe(), "mcp__x__y");
        let long = format!(
            r#"{{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{{"command":"{}"}}}}"#,
            "x".repeat(300)
        );
        assert_eq!(parse_request(&long).unwrap().what.unwrap().chars().count(), 201);
    }

    fn prompt() -> AgentEvent {
        AgentEvent::new("t", AgentKind::Permission, Some("Claude needs your permission".into()), Answers::None)
    }

    fn request(tool: &str) -> Request {
        Request { tool: tool.into(), what: Some("x".into()) }
    }

    #[test]
    fn a_prompt_is_answerable_only_when_its_request_is_clear() {
        let e = with_request(prompt(), vec![request("Bash")]);
        assert_eq!((e.message.as_deref(), e.answers), (Some("Bash: x"), Answers::Decision));
        // Enter there would pick a choice, not allow anything.
        assert_eq!(with_request(prompt(), vec![request("AskUserQuestion")]).answers, Answers::None);
        assert_eq!(with_request(prompt(), vec![request("ExitPlanMode")]).answers, Answers::None);
        // Which of the two is on screen is unknown.
        let two = with_request(prompt(), vec![request("Bash"), request("Edit")]);
        assert_eq!((two.message.as_deref(), two.answers), (Some("Bash, Edit"), Answers::None));
        // Nothing said: as before.
        let none = with_request(prompt(), vec![]);
        assert_eq!((none.message.as_deref(), none.answers), (Some("Claude needs your permission"), Answers::None));
    }

    fn event(id: u64, kind: AgentKind, answers: Answers) -> AgentEvent {
        AgentEvent { id, ..AgentEvent::new("t", kind, None, answers) }
    }

    #[test]
    fn answers_only_what_is_still_on_screen() {
        let (m1, m2) = (InputMark::at(1, 0), InputMark::at(1, 1));
        let allow = Answer::Allow;
        let reply = Answer::Reply("go on".into());

        // A permission prompt: allow or deny it, but not a message.
        let run = Run::record(None, &event(1, AgentKind::Permission, Answers::Decision), m1);
        assert_eq!(keys_for(&run, 1, &allow), Ok(b"\r".to_vec()));
        assert_eq!(keys_for(&run, 1, &Answer::Deny), Ok(b"\x1b".to_vec()));
        assert_eq!(keys_for(&run, 1, &reply), Err(Outcome::Asking));
        assert_eq!(keys_for(&run, 0, &allow), Err(Outcome::Stale));
        // Still the same prompt after an idle reminder about it.
        let run = Run::record(Some(run), &event(2, AgentKind::NeedsInput, Answers::Reply), m1);
        assert_eq!(keys_for(&run, 1, &allow), Ok(b"\r".to_vec()));
        assert_eq!(keys_for(&run, 2, &reply), Err(Outcome::Asking));
        // A newer prompt replaces it.
        let run = Run::record(Some(run), &event(3, AgentKind::Permission, Answers::Decision), m1);
        assert_eq!(keys_for(&run, 1, &allow), Err(Outcome::Stale));
        // A prompt that cannot be decided from a notification.
        let run = Run::record(None, &event(4, AgentKind::Permission, Answers::None), m1);
        assert_eq!(keys_for(&run, 4, &allow), Err(Outcome::Stale));
        // A form takes neither, even for an earlier event of the run.
        let run = Run::record(None, &event(10, AgentKind::Finished, Answers::Reply), m1);
        let run = Run::record(Some(run), &event(11, AgentKind::NeedsInput, Answers::None), m1);
        assert_eq!(keys_for(&run, 10, &reply), Err(Outcome::Asking));
        assert_eq!(keys_for(&run, 11, &allow), Err(Outcome::Stale));

        // A finished turn takes a message, for any event of the run.
        let run = Run::record(None, &event(5, AgentKind::Finished, Answers::Reply), m1);
        let mut run = Run::record(Some(run), &event(6, AgentKind::NeedsInput, Answers::Reply), m1);
        assert_eq!(keys_for(&run, 5, &reply), Ok(b"go on".to_vec()));
        assert_eq!(keys_for(&run, 6, &reply), Ok(b"go on".to_vec()));
        assert_eq!(keys_for(&run, 5, &allow), Err(Outcome::Stale));
        assert_eq!(keys_for(&run, 4, &reply), Err(Outcome::Stale));
        // Once answered, the same answer again is a repeat and any other stale.
        run.answered = Some((5, "reply"));
        assert_eq!(keys_for(&run, 5, &reply), Err(Outcome::Already));
        assert_eq!(keys_for(&run, 6, &reply), Err(Outcome::Stale));

        // Typing in between starts a new run, without the old events.
        let run = Run::record(Some(run), &event(7, AgentKind::Finished, Answers::Reply), m2);
        assert_eq!(keys_for(&run, 5, &reply), Err(Outcome::Stale));
        assert_eq!(keys_for(&run, 7, &reply), Ok(b"go on".to_vec()));
    }

    #[test]
    fn makes_replies_typeable() {
        assert_eq!(reply_text("  yes,\ngo on\x1b[A ").as_deref(), Some("yes, go on [A"));
        assert_eq!(reply_text(" \n\t"), None);
        assert_eq!(reply_text(&"a".repeat(5000)).unwrap().len(), REPLY_MAX_CHARS);
    }
}
