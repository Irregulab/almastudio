//! Visual Studio Code, from the new-tab menu.
//!
//! Preferably inside AlmaStudio: VS Code's command-line tools can serve the
//! editor as a web app (`code serve-web`), which a browser tab then shows.
//! That server reads and writes files and runs commands, so it listens on
//! 127.0.0.1 only and demands a random connection token — without one, any web
//! page open in any browser on the machine could drive it. When the tools are
//! not installed, or the server does not come up, the frontend opens the
//! desktop app instead.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

/// How long the server has to say where it listens. It says so before fetching
/// its server component on first use, so this does not cover a download.
const START_TIMEOUT: Duration = Duration::from_secs(30);

const LOOPBACK: &str = "http://127.0.0.1:";

#[cfg(windows)]
const TUNNEL: &str = "code-tunnel.exe";
#[cfg(not(windows))]
const TUNNEL: &str = "code-tunnel";
#[cfg(windows)]
const LAUNCHER: &str = "code.cmd";
#[cfg(not(windows))]
const LAUNCHER: &str = "code";

/// The one VS Code server, started on first use and ended with the app.
#[derive(Default)]
pub struct VsCodeServer(Mutex<Option<Running>>);

struct Running {
    child: Child,
    /// `http://127.0.0.1:<port>`
    base: String,
    token: String,
}

/// Folders that may hold VS Code's `code` and `code-tunnel`.
fn bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // `code` on the PATH is normally a link into the installation, whose bin
    // folder has `code-tunnel` beside it. A GUI app on macOS starts with
    // launchd's bare PATH, so the usual install locations are added.
    let mut path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    path.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    for dir in path {
        if let Ok(target) = std::fs::canonicalize(dir.join(LAUNCHER)) {
            if let Some(parent) = target.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let bundle = "Visual Studio Code.app/Contents/Resources/app/bin";
        dirs.push(PathBuf::from("/Applications").join(bundle));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Applications").join(bundle));
        }
    }
    #[cfg(target_os = "linux")]
    dirs.extend(
        [
            "/usr/share/code/bin",
            "/opt/visual-studio-code/bin",
            "/snap/code/current/usr/share/code/bin",
        ]
        .map(PathBuf::from),
    );
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join(r"Programs\Microsoft VS Code\bin"));
        }
        if let Some(programs) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(programs).join(r"Microsoft VS Code\bin"));
        }
    }
    dirs
}

fn find(name: &str) -> Option<PathBuf> {
    bin_dirs().into_iter().map(|dir| dir.join(name)).find(|path| path.is_file())
}

/// The address in "Web UI available at http://127.0.0.1:52202?tkn=…".
fn listening_address(line: &str) -> Option<String> {
    let at = line.find(LOOPBACK)?;
    let digits = line[at + LOOPBACK.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    (digits > 0).then(|| line[at..at + LOOPBACK.len() + digits].to_string())
}

/// A file only this user can read; an argument would show in everyone's `ps`.
fn write_token(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("vscode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("connection-token");
    let _ = std::fs::remove_file(&path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path)
}

fn start(app: &AppHandle) -> Result<Running, String> {
    let tunnel = find(TUNNEL).ok_or("Visual Studio Code's command-line tools were not found")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let token_file = write_token(app, &token)?;

    let mut command = Command::new(tunnel);
    command
        .args(["serve-web", "--host", "127.0.0.1", "--port", "0", "--disable-telemetry"])
        .arg("--connection-token-file")
        .arg(&token_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Signalled alone, `code-tunnel` exits and leaves the server it started
    // running; a process group of their own lets `stop` end both.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start VS Code's server: {e}"))?;

    let stdout = child.stdout.take().ok_or("VS Code's server gave no output")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // Read to the end, not just to the address: a full pipe would stall
        // the server.
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(base) = listening_address(&line) {
                let _ = tx.send(base);
            }
        }
    });

    match rx.recv_timeout(START_TIMEOUT) {
        Ok(base) => Ok(Running { child, base, token }),
        Err(_) => {
            end(&mut child);
            Err("VS Code's server did not start".into())
        }
    }
}

/// Ends the server and every process it started, politely first.
fn end(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = child.id() as libc::pid_t;
        // SAFETY: plain syscalls on the process group this module created.
        unsafe { libc::killpg(group, libc::SIGTERM) };
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                // `code-tunnel` is gone; its server may still be shutting down.
                unsafe { libc::killpg(group, libc::SIGKILL) };
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}

/// The address of VS Code with `folder` open, starting the server on first use.
#[tauri::command]
pub async fn vscode_web_url(app: AppHandle, folder: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = app.state::<VsCodeServer>();
        // Held while starting, so a second request waits for the same server.
        let mut running = server.0.lock();
        if running.as_mut().is_some_and(|r| !matches!(r.child.try_wait(), Ok(None))) {
            *running = None;
        }
        if running.is_none() {
            *running = Some(start(&app)?);
        }
        let r = running.as_ref().expect("started above");
        url::Url::parse_with_params(
            &format!("{}/", r.base),
            &[("folder", folder.as_str()), ("tkn", r.token.as_str())],
        )
        .map(|u| u.to_string())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens `folder` in the VS Code desktop app.
#[tauri::command]
pub fn vscode_open_external(folder: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let opened = Command::new("open")
            .args(["-b", "com.microsoft.VSCode"])
            .arg(&folder)
            .status()
            .is_ok_and(|s| s.success());
        if opened {
            return Ok(());
        }
    }
    let launcher = find(LAUNCHER).ok_or("Visual Studio Code was not found")?;
    let mut child = Command::new(launcher)
        .arg(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not open Visual Studio Code: {e}"))?;
    // The launcher hands over to the app and exits; reap it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Ends the server, if one was started. Called as the app exits.
pub fn stop(app: &AppHandle) {
    if let Some(server) = app.try_state::<VsCodeServer>() {
        if let Some(mut running) = server.0.lock().take() {
            end(&mut running.child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_the_server_prints() {
        assert_eq!(
            listening_address("Web UI available at http://127.0.0.1:52202?tkn=0FE7").as_deref(),
            Some("http://127.0.0.1:52202"),
        );
        assert_eq!(
            listening_address("Web UI available at http://127.0.0.1:8000").as_deref(),
            Some("http://127.0.0.1:8000"),
        );
        assert_eq!(listening_address("* Visual Studio Code Server"), None);
        assert_eq!(listening_address("see http://127.0.0.1:/nothing"), None);
    }
}
