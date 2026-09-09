//! PTY-backed sessions for the three tab kinds (claude / codex / shell).
//!
//! Design notes that matter for CPU and memory:
//!
//! * Each session runs **two** threads. The reader thread does a blocking
//!   `read()` on the pty master and appends into a shared buffer; the emitter
//!   thread parks on a condvar until there is data, waits a short coalescing
//!   window, then ships one batch to the webview. Idle sessions therefore cost
//!   exactly zero CPU (no polling timers anywhere), while a `cat` of a huge
//!   file collapses into ~80 IPC messages per second instead of thousands.
//! * Output is emitted base64-encoded so that multi-byte UTF-8 sequences split
//!   across reads survive the trip; xterm.js reassembles them from the bytes.
//! * Every session keeps a bounded ring buffer of recent output. It is flushed
//!   to disk so that tabs can be restored with their previous content after an
//!   app or machine restart.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// How much recent output is retained per session for restore-after-restart.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Coalescing window: upper bound on added output latency.
const COALESCE_MS: u64 = 8;
/// Hard cap on a single IPC batch, so one huge burst cannot stall the webview.
const MAX_BATCH: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Stable tab id, chosen by the frontend and persisted across restarts.
    pub id: String,
    pub cwd: String,
    /// Executable to run. When `login_shell` is set this is run *through* the
    /// user's shell so that PATH additions from nvm/mise/homebrew apply — GUI
    /// apps on macOS otherwise start with a bare PATH and cannot find `claude`.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub login_shell: bool,
    /// Shell used for `login_shell`; falls back to $SHELL / powershell.
    #[serde(default)]
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub id: String,
    pub code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPayload {
    pub id: String,
    /// base64 of raw pty bytes
    pub b64: String,
    /// Total bytes emitted for this session up to and including this batch.
    pub end: u64,
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Ring {
    buf: VecDeque<u8>,
    dirty: bool,
    /// Bytes ever appended, not just retained. Used as a stream offset so a
    /// reattaching tab can tell which emitted batches its snapshot already
    /// covers, and neither duplicate nor drop output.
    total: u64,
}

impl Ring {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        if bytes.len() >= SCROLLBACK_CAP {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - SCROLLBACK_CAP..]);
        } else {
            self.buf.extend(bytes);
            let overflow = self.buf.len().saturating_sub(SCROLLBACK_CAP);
            if overflow > 0 {
                self.buf.drain(..overflow);
            }
        }
        self.dirty = true;
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn take_if_dirty(&mut self) -> Option<Vec<u8>> {
        if self.dirty {
            self.dirty = false;
            Some(self.snapshot())
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

struct Outbox {
    buf: Vec<u8>,
    closed: bool,
}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub ring: Arc<Mutex<Ring>>,
    alive: Arc<AtomicBool>,
    exit_code: Arc<AtomicI32>,
}

impl Session {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    pub fn ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }

    pub fn ring_of(&self, id: &str) -> Option<Arc<Mutex<Ring>>> {
        self.sessions.lock().get(id).map(|s| s.ring.clone())
    }

    pub fn kill_all(&self) {
        let mut guard = self.sessions.lock();
        for (_, s) in guard.iter_mut() {
            let _ = s.child.lock().kill();
        }
        guard.clear();
    }

    pub fn spawn(&self, app: &AppHandle, opts: SpawnOptions) -> anyhow::Result<()> {
        // Replace any previous session under the same tab id.
        if let Some(mut old) = self.sessions.lock().remove(&opts.id) {
            let _ = old.child.lock().kill();
            let _ = old.writer.flush();
        }

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: opts.rows.max(2),
            cols: opts.cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let cmd = build_command(&opts)?;
        let child = pair.slave.spawn_command(cmd)?;
        // The slave handle must be dropped, otherwise the master never sees EOF
        // when the child exits and the reader thread would hang forever.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let ring = Arc::new(Mutex::new(Ring::default()));
        let alive = Arc::new(AtomicBool::new(true));
        let exit_code = Arc::new(AtomicI32::new(0));
        let child = Arc::new(Mutex::new(child));

        let outbox = Arc::new((
            Mutex::new(Outbox { buf: Vec::new(), closed: false }),
            Condvar::new(),
        ));

        spawn_reader(reader, outbox.clone(), ring.clone());
        spawn_emitter(app.clone(), opts.id.clone(), outbox.clone());
        spawn_reaper(
            app.clone(),
            opts.id.clone(),
            child.clone(),
            alive.clone(),
            exit_code.clone(),
            outbox,
        );

        self.sessions.lock().insert(
            opts.id,
            Session { master: pair.master, writer, child, ring, alive, exit_code },
        );
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let mut guard = self.sessions.lock();
        let s = guard
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let guard = self.sessions.lock();
        let s = guard
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
        s.master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().remove(id) {
            let _ = s.child.lock().kill();
            let _ = s.writer.flush();
        }
    }

    pub fn status(&self, id: &str) -> Option<(bool, i32)> {
        self.sessions
            .lock()
            .get(id)
            .map(|s| (s.is_alive(), s.exit_code.load(Ordering::Relaxed)))
    }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

type Shared = Arc<(Mutex<Outbox>, Condvar)>;

fn spawn_reader(mut reader: Box<dyn Read + Send>, shared: Shared, ring: Arc<Mutex<Ring>>) {
    thread::spawn(move || {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &chunk[..n];
                    ring.lock().push(bytes);
                    let (lock, cv) = &*shared;
                    let mut ob = lock.lock();
                    ob.buf.extend_from_slice(bytes);
                    cv.notify_one();
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let (lock, cv) = &*shared;
        lock.lock().closed = true;
        cv.notify_all();
    });
}

fn spawn_emitter(app: AppHandle, id: String, shared: Shared) {
    thread::spawn(move || {
        let event = format!("pty://data/{id}");
        let engine = base64::engine::general_purpose::STANDARD;
        // Mirrors Ring::total: the reader appends the same bytes in the same
        // order to both, so the two counters describe the same stream.
        let mut emitted: u64 = 0;
        loop {
            {
                // Park until there is something to send. No timer, no polling:
                // an idle terminal consumes no CPU at all.
                let (lock, cv) = &*shared;
                let mut ob = lock.lock();
                while ob.buf.is_empty() && !ob.closed {
                    cv.wait(&mut ob);
                }
                if ob.buf.is_empty() && ob.closed {
                    break;
                }
            }
            // Let a burst accumulate before crossing the IPC boundary.
            thread::sleep(Duration::from_millis(COALESCE_MS));

            let batch = {
                let (lock, _) = &*shared;
                let mut ob = lock.lock();
                if ob.buf.len() > MAX_BATCH {
                    ob.buf.drain(..MAX_BATCH).collect::<Vec<u8>>()
                } else {
                    std::mem::take(&mut ob.buf)
                }
            };
            if batch.is_empty() {
                continue;
            }
            emitted += batch.len() as u64;
            let payload =
                DataPayload { id: id.clone(), b64: engine.encode(&batch), end: emitted };
            if app.emit(&event, payload).is_err() {
                break;
            }
        }
    });
}

fn spawn_reaper(
    app: AppHandle,
    id: String,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    alive: Arc<AtomicBool>,
    exit_code: Arc<AtomicI32>,
    shared: Shared,
) {
    thread::spawn(move || {
        // `Child::wait` needs the lock, so poll `try_wait` on a slow cadence to
        // avoid holding it; this thread exists only until the child dies.
        let code = loop {
            let status = { child.lock().try_wait() };
            match status {
                Ok(Some(st)) => break st.exit_code() as i32,
                Ok(None) => thread::sleep(Duration::from_millis(200)),
                Err(_) => break -1,
            }
        };
        alive.store(false, Ordering::Relaxed);
        exit_code.store(code, Ordering::Relaxed);

        // Give the emitter a moment to drain the final output before the tab is
        // told the process is gone, so last words are not lost.
        thread::sleep(Duration::from_millis(COALESCE_MS * 4));
        let (lock, cv) = &*shared;
        lock.lock().closed = true;
        cv.notify_all();

        let _ = app.emit(&format!("pty://exit/{id}"), ExitPayload { id: id.clone(), code });
    });
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

fn posix_quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@%+=:,./-_".contains(&b))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn build_command(opts: &SpawnOptions) -> anyhow::Result<CommandBuilder> {
    let shell = opts.shell.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);

    let mut cmd = if opts.program.trim().is_empty() {
        // Plain terminal tab: an interactive login shell, nothing wrapped.
        let mut c = CommandBuilder::new(&shell);
        if !cfg!(windows) {
            c.arg("-l");
        }
        c
    } else if !opts.login_shell {
        let mut c = CommandBuilder::new(&opts.program);
        for a in &opts.args {
            c.arg(a);
        }
        c
    } else if cfg!(windows) {
        // cmd.exe resolves the `.cmd` shims that npm-installed CLIs ship with,
        // which a bare CreateProcess does not.
        let mut line = opts.program.clone();
        for a in &opts.args {
            line.push(' ');
            line.push_str(a);
        }
        let mut c = CommandBuilder::new(shell);
        c.arg("/d");
        c.arg("/s");
        c.arg("/c");
        c.arg(line);
        c
    } else {
        // A login shell so nvm / mise / asdf / homebrew PATH entries exist.
        // Bundled macOS apps otherwise inherit a bare PATH from launchd.
        let mut line = String::from("exec ");
        line.push_str(&posix_quote(&opts.program));
        for a in &opts.args {
            line.push(' ');
            line.push_str(&posix_quote(a));
        }
        let mut c = CommandBuilder::new(shell);
        c.arg("-l");
        c.arg("-c");
        c.arg(line);
        c
    };

    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("ALMASTUDIO", "1");
    // Some CLIs use this to decide whether to draw a TUI.
    cmd.env("TERM_PROGRAM", "AlmaStudio");
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    Ok(cmd)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    mgr: tauri::State<'_, PtyManager>,
    options: SpawnOptions,
) -> Result<(), String> {
    mgr.spawn(&app, options).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_write(mgr: tauri::State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    mgr.write(&id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    mgr: tauri::State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    mgr.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(mgr: tauri::State<'_, PtyManager>, id: String) {
    mgr.kill(&id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStatus {
    pub running: bool,
    pub alive: bool,
    pub exit_code: i32,
}

#[tauri::command]
pub fn pty_status(mgr: tauri::State<'_, PtyManager>, id: String) -> PtyStatus {
    match mgr.status(&id) {
        Some((alive, code)) => PtyStatus { running: true, alive, exit_code: code },
        None => PtyStatus { running: false, alive: false, exit_code: 0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn opts(program: &str, args: &[&str], login: bool) -> SpawnOptions {
        SpawnOptions {
            id: "t".into(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
            login_shell: login,
            shell: if cfg!(windows) { None } else { Some("/bin/sh".into()) },
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn quotes_only_what_needs_quoting() {
        assert_eq!(posix_quote("claude"), "claude");
        assert_eq!(posix_quote("--continue"), "--continue");
        assert_eq!(posix_quote("/usr/local/bin/x"), "/usr/local/bin/x");
        assert_eq!(posix_quote("two words"), "'two words'");
        assert_eq!(posix_quote(""), "''");
        // The dangerous cases: an argument must never be able to end the
        // quoting and start a new command.
        assert_eq!(posix_quote("a'b"), r"'a'\''b'");
        assert_eq!(posix_quote("; rm -rf /"), "'; rm -rf /'");
        assert_eq!(posix_quote("$(whoami)"), "'$(whoami)'");
    }

    #[test]
    fn ring_caps_and_counts() {
        let mut r = Ring::default();
        r.push(b"hello");
        assert_eq!(r.snapshot(), b"hello");
        assert_eq!(r.total(), 5);

        // Overflowing keeps the tail and still counts everything seen.
        let big = vec![b'x'; SCROLLBACK_CAP + 100];
        r.push(&big);
        assert_eq!(r.snapshot().len(), SCROLLBACK_CAP);
        assert_eq!(r.total(), 5 + big.len() as u64);
    }

    #[test]
    fn ring_dirty_flag_clears_after_take() {
        let mut r = Ring::default();
        assert!(r.take_if_dirty().is_none());
        r.push(b"x");
        assert!(r.take_if_dirty().is_some());
        assert!(r.take_if_dirty().is_none());
    }

    /// Reads from a pty on a worker thread until `needle` shows up or the
    /// deadline passes. Reading inline would block forever: a pty master does
    /// not reliably reach EOF just because the child exited.
    #[cfg(not(windows))]
    fn read_until(
        mut reader: Box<dyn Read + Send>,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let deadline = std::time::Instant::now() + timeout;
        let mut out = String::new();
        while std::time::Instant::now() < deadline {
            let left = deadline - std::time::Instant::now();
            match rx.recv_timeout(left) {
                Ok(chunk) => {
                    out.push_str(&String::from_utf8_lossy(&chunk));
                    if out.contains(needle) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        out
    }

    /// The important one: an agent launched through a login shell must actually
    /// run, with its arguments intact. This is what breaks on macOS when a
    /// bundled app inherits launchd's bare PATH.
    #[test]
    #[cfg(not(windows))]
    fn login_shell_runs_the_program_with_its_arguments() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let cmd = build_command(&opts("echo", &["hello world", "second"], true)).unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().unwrap();
        let out = read_until(reader, "second", Duration::from_secs(20));
        let _ = child.kill();
        let _ = child.wait();

        assert!(out.contains("hello world"), "got: {out:?}");
        assert!(out.contains("second"), "got: {out:?}");
    }

    #[test]
    #[cfg(not(windows))]
    fn empty_program_starts_a_plain_shell() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let o = opts("", &[], true);
        let cmd = build_command(&o).unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"echo marker-42\n").unwrap();
        writer.flush().unwrap();

        let reader = pair.master.try_clone_reader().unwrap();
        let out = read_until(reader, "marker-42", Duration::from_secs(20));
        let _ = child.kill();
        let _ = child.wait();

        assert!(out.contains("marker-42"), "got: {out:?}");
    }
}
