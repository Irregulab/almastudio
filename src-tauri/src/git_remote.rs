//! Fetch, pull and push, through the `git` command line.
//!
//! The rest of the panel uses libgit2 in-process, built here without network
//! support. Talking to a remote goes through `git` itself instead, as VS Code
//! does, so the user's credential helpers, SSH agent, hooks and settings such
//! as `pull.rebase` apply exactly as they do in a terminal.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use git2::{BranchType, Repository};

/// A fetch over a slow link can take a while, but not forever.
const TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(windows)]
const GIT: &str = "git.exe";
#[cfg(not(windows))]
const GIT: &str = "git";

/// `git`, preferring Homebrew's: a GUI app on macOS starts with launchd's bare
/// PATH, which has only Apple's.
fn git_binary() -> Option<PathBuf> {
    #[cfg(unix)]
    let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    #[cfg(not(unix))]
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    #[cfg(unix)]
    dirs.push(PathBuf::from("/usr/bin"));
    #[cfg(windows)]
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(programs).join(r"Git\cmd"));
    }
    dirs.into_iter().map(|dir| dir.join(GIT)).find(|path| path.is_file())
}

/// Runs git in `root`. What it printed on success; its error message otherwise.
fn run(root: &str, args: &[&str]) -> Result<String, String> {
    let git = git_binary().ok_or("git was not found")?;
    let mut command = Command::new(git);
    command
        .current_dir(root)
        .args(args)
        // Nobody can answer a username or password prompt here: fail at once
        // rather than wait on one.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("could not run git: {e}"))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} took too long and was stopped", args[0]));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if status.success() {
        // git reports what a fetch or push did on stderr.
        Ok(tidy(&format!("{err}\n{out}")))
    } else {
        let message = tidy(&err);
        Err(if message.is_empty() { format!("git {} failed ({status})", args[0]) } else { message })
    }
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// git's output without blank lines and its `hint:` advice.
fn tidy(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.starts_with("hint:"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where to publish the checked-out branch on its first push: the remote
/// (`origin` if there is one) and the branch. None once it has an upstream.
fn publish_target(root: &str) -> Result<Option<(String, String)>, String> {
    let repo = Repository::discover(root).map_err(|e| format!("not a git repository: {e}"))?;
    let head = repo.head().map_err(|e| e.to_string())?;
    if !head.is_branch() {
        return Err("HEAD is detached: check out a branch to push it".into());
    }
    let name = head.shorthand().map_err(|e| e.to_string())?.to_string();
    let branch = repo.find_branch(&name, BranchType::Local).map_err(|e| e.to_string())?;
    if branch.upstream().is_ok() {
        return Ok(None);
    }
    let remotes = repo.remotes().map_err(|e| e.to_string())?;
    let remote = remotes
        .iter()
        .flatten()
        .flatten()
        .find(|remote| *remote == "origin")
        .or_else(|| remotes.iter().flatten().flatten().next())
        .ok_or("this repository has no remote to push to")?
        .to_string();
    Ok(Some((remote, name)))
}

fn fetch(root: &str) -> Result<String, String> {
    run(root, &["fetch", "--all"])
}

fn pull(root: &str) -> Result<String, String> {
    run(root, &["pull"])
}

/// Pushes the checked-out branch, publishing it with an upstream on its first
/// push, as VS Code's Publish Branch does.
fn push(root: &str) -> Result<String, String> {
    match publish_target(root)? {
        Some((remote, branch)) => run(root, &["push", "--set-upstream", &remote, &branch]),
        None => run(root, &["push"]),
    }
}

async fn in_background(
    work: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    in_background(move || fetch(&root)).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    in_background(move || pull(&root)).await
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    in_background(move || push(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::path::Path;

    fn commit(repo: &Repository, file: &str, message: &str) {
        let root = repo.workdir().unwrap();
        std::fs::write(root.join(file), message).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    }

    fn head_summary(path: &Path) -> String {
        let repo = Repository::open(path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        commit.summary().unwrap().unwrap().to_string()
    }

    #[test]
    fn publishes_pushes_fetches_and_pulls() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        Repository::init_bare(&remote).unwrap();
        let remote = remote.to_str().unwrap();

        let a_path = dir.path().join("a");
        let a = Repository::init(&a_path).unwrap();
        commit(&a, "one.txt", "one");
        a.remote("origin", remote).unwrap();
        let a_root = a_path.to_str().unwrap();

        // No upstream yet: the first push publishes the branch.
        assert!(publish_target(a_root).unwrap().is_some());
        push(a_root).unwrap();
        assert!(publish_target(a_root).unwrap().is_none());

        // Someone else pushes a commit…
        run(dir.path().to_str().unwrap(), &["clone", remote, "b"]).unwrap();
        let b_path = dir.path().join("b");
        commit(&Repository::open(&b_path).unwrap(), "two.txt", "two");
        push(b_path.to_str().unwrap()).unwrap();

        // …which a fetch learns of and a pull brings in.
        fetch(a_root).unwrap();
        assert_eq!(head_summary(&a_path), "one");
        pull(a_root).unwrap();
        assert_eq!(head_summary(&a_path), "two");
    }

    #[test]
    fn reports_what_went_wrong() {
        let dir = tempfile::tempdir().unwrap();
        commit(&Repository::init(dir.path()).unwrap(), "one.txt", "one");
        let root = dir.path().to_str().unwrap();

        let err = push(root).unwrap_err();
        assert!(err.contains("no remote"), "{err}");
        let err = pull(root).unwrap_err();
        assert!(!err.is_empty() && !err.contains("hint:"), "{err}");
    }

    #[test]
    fn tidy_drops_hints_and_blank_lines() {
        assert_eq!(
            tidy("error: failed to push some refs\nhint: Updates were rejected\n\nhint: see docs\n"),
            "error: failed to push some refs",
        );
    }
}
