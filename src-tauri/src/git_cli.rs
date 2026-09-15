//! Git operations that change a repository or talk to a remote, run through
//! the `git` command line.
//!
//! Reads — status, diffs, the graph — use libgit2 in-process (see `git`),
//! which is fast and built here without network support. Everything that
//! writes goes through `git` itself instead, as VS Code does: commit hooks
//! run, commits are signed when the user signs them, and credential helpers,
//! the SSH agent and settings such as `pull.rebase` apply exactly as they do
//! in a terminal.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use git2::{BranchType, Repository};

/// A fetch over a slow link can take a while, but not forever.
const TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(windows)]
const GIT: &str = "git.exe";
#[cfg(not(windows))]
const GIT: &str = "git";

/// The PATH of the user's login shell, looked up once. A GUI app on macOS
/// starts with launchd's bare PATH, which would leave hooks (husky's `npx`)
/// and credential helpers (`gh auth git-credential`) unable to run.
#[cfg(unix)]
fn login_path() -> Option<&'static str> {
    static PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let child = Command::new(shell)
            .args(["-l", "-c", "printf '\\n%s' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let (status, out, _) = finish(child, Duration::from_secs(10)).ok()?;
        // A login shell may greet first; the PATH is on the last line.
        let path = out.lines().last()?.trim().to_string();
        (status.success() && path.contains('/')).then_some(path)
    })
    .as_deref()
}

#[cfg(not(unix))]
fn login_path() -> Option<&'static str> {
    None
}

/// `git` on the login shell's PATH, then in Homebrew's and the system's usual
/// places.
fn git_binary(login_path: Option<&str>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = login_path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    #[cfg(unix)]
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
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

/// Waits for a process, up to `timeout`, collecting what it printed.
fn finish(mut child: Child, timeout: Duration) -> Result<(ExitStatus, String, String), String> {
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("took too long and was stopped".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok((status, stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default()))
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

fn run(root: &str, args: &[&str]) -> Result<String, String> {
    run_with(root, args, None)
}

/// Runs git in `root`, with `input` on its stdin. What it printed on success;
/// what it said went wrong otherwise.
fn run_with(root: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    let path = login_path();
    let git = git_binary(path).ok_or("git was not found")?;
    let mut command = Command::new(git);
    command
        .current_dir(root)
        .args(args)
        // Nobody can answer a username or password prompt here: fail at once
        // rather than wait on one.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Continuing a merge or rebase would open an editor on the message;
        // take the one git proposes, as the buttons promise.
        .env("GIT_EDITOR", "true")
        // English messages, which is what is recognised (e.g. an unmerged
        // branch refusing deletion); hooks keep the rest of the locale.
        .env("LANG", "en_US.UTF-8")
        .env("LC_MESSAGES", "en_US.UTF-8")
        .env_remove("LC_ALL")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let input = input.to_string();
        // From its own thread, so a long message cannot block on a full pipe.
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let (status, out, err) = finish(child, TIMEOUT).map_err(|e| format!("git {} {e}", args[0]))?;
    // Conflicts are reported on stdout, most errors on stderr: keep both.
    let said = tidy(&format!("{err}\n{out}"));
    if status.success() {
        Ok(said)
    } else if said.is_empty() {
        Err(format!("git {} failed ({status})", args[0]))
    } else {
        Err(said)
    }
}

fn open(root: &str) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("not a git repository: {e}"))
}

// ----------------------------------------------------------------- remote ---

fn fetch(root: &str) -> Result<String, String> {
    run(root, &["fetch", "--all"])
}

fn pull(root: &str, rebase: bool) -> Result<String, String> {
    if rebase {
        run(root, &["pull", "--rebase"])
    } else {
        run(root, &["pull"])
    }
}

/// Where to publish the checked-out branch on its first push: the remote
/// (`origin` if there is one) and the branch. None once it has an upstream.
fn publish_target(root: &str) -> Result<Option<(String, String)>, String> {
    let repo = open(root)?;
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

/// Pushes the checked-out branch, publishing it with an upstream on its first
/// push, as VS Code's Publish Branch does.
fn push(root: &str) -> Result<String, String> {
    match publish_target(root)? {
        Some((remote, branch)) => run(root, &["push", "--set-upstream", &remote, &branch]),
        None => run(root, &["push"]),
    }
}

/// VS Code's Sync Changes: pull, then push.
fn sync(root: &str) -> Result<String, String> {
    let pulled = pull(root, false)?;
    let pushed = push(root)?;
    Ok(tidy(&format!("{pulled}\n{pushed}")))
}

fn push_tags(root: &str) -> Result<String, String> {
    run(root, &["push", "--tags"])
}

// ----------------------------------------------------------------- commit ---

/// Commits what is staged, or every change with `stage_all`. With `amend` it
/// replaces the last commit, keeping its message when none is given.
fn commit(root: &str, message: &str, stage_all: bool, amend: bool) -> Result<String, String> {
    let empty = message.trim().is_empty();
    if empty && !amend {
        return Err("the commit message is empty".into());
    }
    if stage_all {
        run(root, &["add", "--all"])?;
    }
    match (amend, empty) {
        (true, true) => run(root, &["commit", "--amend", "--no-edit"]),
        (true, false) => run_with(root, &["commit", "--amend", "--file", "-"], Some(message)),
        (false, _) => run_with(root, &["commit", "--file", "-"], Some(message)),
    }
}

/// VS Code's Undo Last Commit: the commit goes, its changes stay staged, and
/// its message is returned to be put back in the box.
fn undo_commit(root: &str) -> Result<String, String> {
    let repo = open(root)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| "there is no commit to undo".to_string())?;
    let message = head.message().unwrap_or("").trim_end().to_string();
    if head.parent_count() == 0 {
        // The first commit has nothing to reset to; unborn again, its files
        // stay in the index.
        run(root, &["update-ref", "-d", "HEAD"])?;
    } else {
        run(root, &["reset", "--soft", "HEAD~1"])?;
    }
    Ok(message)
}

// --------------------------------------------------------------- branches ---

/// Checks out a branch or commit. A remote branch is checked out as the local
/// branch tracking it, created on first use.
fn checkout(root: &str, name: &str, remote: bool) -> Result<String, String> {
    if !remote {
        return run(root, &["checkout", name]);
    }
    let local = name.split_once('/').map_or(name, |(_, branch)| branch);
    if open(root)?.find_branch(local, BranchType::Local).is_ok() {
        run(root, &["checkout", local])
    } else {
        run(root, &["checkout", "--track", name])
    }
}

fn create_branch(root: &str, name: &str, start: Option<&str>, check_out: bool) -> Result<String, String> {
    let mut args = if check_out { vec!["checkout", "-b", name] } else { vec!["branch", name] };
    args.extend(start);
    run(root, &args)
}

fn rename_branch(root: &str, from: &str, to: &str) -> Result<String, String> {
    run(root, &["branch", "--move", from, to])
}

/// Without `force`, git refuses a branch whose commits are merged nowhere.
fn delete_branch(root: &str, name: &str, force: bool) -> Result<String, String> {
    run(root, &["branch", if force { "-D" } else { "-d" }, name])
}

fn delete_remote_branch(root: &str, name: &str) -> Result<String, String> {
    let (remote, branch) = name
        .split_once('/')
        .ok_or_else(|| format!("{name} is not a remote branch"))?;
    run(root, &["push", remote, "--delete", branch])
}

fn merge(root: &str, name: &str) -> Result<String, String> {
    run(root, &["merge", "--no-edit", name])
}

fn rebase(root: &str, onto: &str) -> Result<String, String> {
    run(root, &["rebase", onto])
}

/// The git command that continues or aborts the operation under way.
fn operation_command(root: &str) -> Result<&'static str, String> {
    use git2::RepositoryState as State;
    Ok(match open(root)?.state() {
        State::Clean => return Err("no merge, rebase, cherry-pick or revert is under way".into()),
        State::Merge => "merge",
        State::Revert | State::RevertSequence => "revert",
        State::CherryPick | State::CherryPickSequence => "cherry-pick",
        State::Bisect => "bisect",
        _ => "rebase",
    })
}

fn continue_operation(root: &str) -> Result<String, String> {
    match operation_command(root)? {
        // A merge is concluded by committing it.
        "merge" => run(root, &["commit", "--no-edit"]),
        "bisect" => Err("a bisect is not continued from here".into()),
        op => run(root, &[op, "--continue"]),
    }
}

fn abort_operation(root: &str) -> Result<String, String> {
    match operation_command(root)? {
        "bisect" => run(root, &["bisect", "reset"]),
        op => run(root, &[op, "--abort"]),
    }
}

// ------------------------------------------------------------ stash, tags ---

fn stash(root: &str, message: Option<&str>, include_untracked: bool) -> Result<String, String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["--message", message]);
    }
    run(root, &args)
}

fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}

fn stash_apply(root: &str, index: usize) -> Result<String, String> {
    run(root, &["stash", "apply", &stash_ref(index)])
}

fn stash_pop(root: &str, index: usize) -> Result<String, String> {
    run(root, &["stash", "pop", &stash_ref(index)])
}

fn stash_drop(root: &str, index: usize) -> Result<String, String> {
    run(root, &["stash", "drop", &stash_ref(index)])
}

/// An annotated tag when there is a message, a lightweight one otherwise.
fn create_tag(root: &str, name: &str, message: Option<&str>, target: Option<&str>) -> Result<String, String> {
    let mut args = vec!["tag"];
    if let Some(message) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["--annotate", "--message", message]);
    }
    args.push(name);
    args.extend(target);
    run(root, &args)
}

fn delete_tag(root: &str, name: &str) -> Result<String, String> {
    run(root, &["tag", "--delete", name])
}

// --------------------------------------------------------------- commands ---

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
pub async fn git_pull(root: String, rebase: Option<bool>) -> Result<String, String> {
    in_background(move || pull(&root, rebase.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    in_background(move || push(&root)).await
}

#[tauri::command]
pub async fn git_sync(root: String) -> Result<String, String> {
    in_background(move || sync(&root)).await
}

#[tauri::command]
pub async fn git_push_tags(root: String) -> Result<String, String> {
    in_background(move || push_tags(&root)).await
}

#[tauri::command]
pub async fn git_commit(
    root: String,
    message: String,
    stage_all: bool,
    amend: Option<bool>,
) -> Result<String, String> {
    in_background(move || commit(&root, &message, stage_all, amend.unwrap_or(false))).await
}

/// Resolves to the undone commit's message.
#[tauri::command]
pub async fn git_undo_commit(root: String) -> Result<String, String> {
    in_background(move || undo_commit(&root)).await
}

#[tauri::command]
pub async fn git_checkout(root: String, name: String, remote: Option<bool>) -> Result<String, String> {
    in_background(move || checkout(&root, &name, remote.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_create_branch(
    root: String,
    name: String,
    start_point: Option<String>,
    checkout: Option<bool>,
) -> Result<String, String> {
    in_background(move || {
        create_branch(&root, &name, start_point.as_deref(), checkout.unwrap_or(true))
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(root: String, from: String, to: String) -> Result<String, String> {
    in_background(move || rename_branch(&root, &from, &to)).await
}

#[tauri::command]
pub async fn git_delete_branch(root: String, name: String, force: Option<bool>) -> Result<String, String> {
    in_background(move || delete_branch(&root, &name, force.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_delete_remote_branch(root: String, name: String) -> Result<String, String> {
    in_background(move || delete_remote_branch(&root, &name)).await
}

#[tauri::command]
pub async fn git_merge(root: String, name: String) -> Result<String, String> {
    in_background(move || merge(&root, &name)).await
}

#[tauri::command]
pub async fn git_rebase(root: String, onto: String) -> Result<String, String> {
    in_background(move || rebase(&root, &onto)).await
}

#[tauri::command]
pub async fn git_continue(root: String) -> Result<String, String> {
    in_background(move || continue_operation(&root)).await
}

#[tauri::command]
pub async fn git_abort(root: String) -> Result<String, String> {
    in_background(move || abort_operation(&root)).await
}

#[tauri::command]
pub async fn git_stash(
    root: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<String, String> {
    in_background(move || stash(&root, message.as_deref(), include_untracked.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_stash_apply(root: String, index: usize) -> Result<String, String> {
    in_background(move || stash_apply(&root, index)).await
}

#[tauri::command]
pub async fn git_stash_pop(root: String, index: usize) -> Result<String, String> {
    in_background(move || stash_pop(&root, index)).await
}

#[tauri::command]
pub async fn git_stash_drop(root: String, index: usize) -> Result<String, String> {
    in_background(move || stash_drop(&root, index)).await
}

#[tauri::command]
pub async fn git_create_tag(
    root: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    in_background(move || create_tag(&root, &name, message.as_deref(), target.as_deref())).await
}

#[tauri::command]
pub async fn git_delete_tag(root: String, name: String) -> Result<String, String> {
    in_background(move || delete_tag(&root, &name)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{git_stashes, git_status, git_tags};
    use std::fs;
    use std::path::Path;

    /// An identity, and none of this machine's commit signing or hooks.
    fn configure(repo: &Repository) {
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        config.set_bool("commit.gpgsign", false).unwrap();
        config.set_bool("tag.gpgsign", false).unwrap();
        config.set_str("core.hooksPath", "/nonexistent-hooks").unwrap();
    }

    fn repo_at(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        configure(&repo);
        repo
    }

    fn root_of(repo: &Repository) -> String {
        repo.workdir().unwrap().to_string_lossy().into_owned()
    }

    fn write(repo: &Repository, file: &str, body: &str) {
        fs::write(repo.workdir().unwrap().join(file), body).unwrap();
    }

    fn read(repo: &Repository, file: &str) -> Option<String> {
        fs::read_to_string(repo.workdir().unwrap().join(file)).ok()
    }

    fn head_message(repo: &Repository) -> String {
        repo.head().unwrap().peel_to_commit().unwrap().message().unwrap().to_string()
    }

    fn current_branch(repo: &Repository) -> String {
        repo.head().unwrap().shorthand().unwrap().to_string()
    }

    #[test]
    fn commits_amends_and_undoes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);

        write(&repo, "a.txt", "one");
        commit(&root, "First\n\nWith a body", true, false).unwrap();
        assert_eq!(head_message(&repo), "First\n\nWith a body\n");
        assert!(commit(&root, "   ", true, false).is_err());

        // Amending with no message keeps the old one and takes the new change.
        write(&repo, "b.txt", "two");
        commit(&root, "", true, true).unwrap();
        assert_eq!(head_message(&repo), "First\n\nWith a body\n");
        assert!(repo.head().unwrap().peel_to_tree().unwrap().get_name("b.txt").is_some());

        write(&repo, "c.txt", "three");
        commit(&root, "Second", true, false).unwrap();
        assert_eq!(undo_commit(&root).unwrap(), "Second");
        assert_eq!(head_message(&repo), "First\n\nWith a body\n");
        // The undone commit's changes stay, staged.
        assert!(repo.status_file(Path::new("c.txt")).unwrap().contains(git2::Status::INDEX_NEW));

        // Undoing the very first commit leaves a repository with none.
        undo_commit(&root).unwrap();
        assert!(repo.head().is_err());
        assert!(repo.status_file(Path::new("a.txt")).unwrap().contains(git2::Status::INDEX_NEW));
    }

    #[test]
    fn creates_renames_merges_and_deletes_branches() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);
        write(&repo, "a.txt", "base\n");
        commit(&root, "Base", true, false).unwrap();
        let main = current_branch(&repo);

        create_branch(&root, "feature", None, true).unwrap();
        assert_eq!(current_branch(&repo), "feature");
        write(&repo, "f.txt", "feature\n");
        commit(&root, "Feature work", true, false).unwrap();
        rename_branch(&root, "feature", "topic").unwrap();
        checkout(&root, &main, false).unwrap();

        // Merged nowhere yet: a plain delete refuses.
        let err = delete_branch(&root, "topic", false).unwrap_err();
        assert!(err.contains("not fully merged"), "{err}");

        merge(&root, "topic").unwrap();
        assert_eq!(head_message(&repo), "Feature work\n");
        delete_branch(&root, "topic", false).unwrap();
        assert!(repo.find_branch("topic", BranchType::Local).is_err());

        create_branch(&root, "doomed", None, false).unwrap();
        assert_eq!(current_branch(&repo), main);
        delete_branch(&root, "doomed", true).unwrap();
    }

    #[test]
    fn reports_a_conflicted_merge_and_aborts_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);
        write(&repo, "a.txt", "base\n");
        commit(&root, "Base", true, false).unwrap();
        let main = current_branch(&repo);
        create_branch(&root, "other", None, true).unwrap();
        write(&repo, "a.txt", "theirs\n");
        commit(&root, "Theirs", true, false).unwrap();
        checkout(&root, &main, false).unwrap();
        write(&repo, "a.txt", "ours\n");
        commit(&root, "Ours", true, false).unwrap();

        let err = merge(&root, "other").unwrap_err();
        assert!(err.contains("CONFLICT"), "{err}");
        let status = git_status(root.clone()).unwrap();
        assert_eq!(status.operation, Some("merge"));
        assert!(status.files.iter().any(|f| f.conflicted));
        assert!(continue_operation(&root).is_err());

        abort_operation(&root).unwrap();
        assert_eq!(git_status(root.clone()).unwrap().operation, None);
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("ours\n"));
        assert!(abort_operation(&root).is_err());
    }

    #[test]
    fn stashes_and_restores_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);
        write(&repo, "a.txt", "base\n");
        commit(&root, "Base", true, false).unwrap();

        write(&repo, "a.txt", "changed\n");
        write(&repo, "new.txt", "untracked\n");
        stash(&root, None, true).unwrap();
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("base\n"));
        assert_eq!(read(&repo, "new.txt"), None);
        assert_eq!(git_stashes(root.clone()).unwrap().len(), 1);

        stash_pop(&root, 0).unwrap();
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("changed\n"));
        assert!(read(&repo, "new.txt").is_some());
        assert!(git_stashes(root.clone()).unwrap().is_empty());

        stash(&root, Some("Saved for later"), false).unwrap();
        let stashes = git_stashes(root.clone()).unwrap();
        assert!(stashes[0].message.contains("Saved for later"), "{:?}", stashes);
        assert!(stashes[0].time > 0);
        stash_apply(&root, 0).unwrap();
        assert_eq!(git_stashes(root.clone()).unwrap().len(), 1);
        stash_drop(&root, 0).unwrap();
        assert!(git_stashes(root).unwrap().is_empty());
    }

    #[test]
    fn creates_and_deletes_tags() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);
        write(&repo, "a.txt", "base\n");
        commit(&root, "Base", true, false).unwrap();
        let head = repo.head().unwrap().target().unwrap().to_string();

        create_tag(&root, "v1", None, None).unwrap();
        create_tag(&root, "v2", Some("Release two"), None).unwrap();
        let tags = git_tags(root.clone()).unwrap();
        assert_eq!(tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["v1", "v2"]);
        assert!(tags.iter().all(|t| head.starts_with(&t.target)));

        delete_tag(&root, "v1").unwrap();
        assert_eq!(git_tags(root).unwrap().len(), 1);
    }

    #[test]
    fn publishes_pushes_fetches_pulls_and_tracks_remote_branches() {
        let dir = tempfile::tempdir().unwrap();
        let remote_path = dir.path().join("remote.git");
        let bare = Repository::init_bare(&remote_path).unwrap();
        let remote = remote_path.to_str().unwrap();

        let a = repo_at(&dir.path().join("a"));
        let a_root = root_of(&a);
        write(&a, "one.txt", "one");
        commit(&a_root, "One", true, false).unwrap();
        a.remote("origin", remote).unwrap();
        let main = current_branch(&a);

        // No upstream yet: the first push publishes the branch.
        assert!(publish_target(&a_root).unwrap().is_some());
        push(&a_root).unwrap();
        assert!(publish_target(&a_root).unwrap().is_none());
        create_branch(&a_root, "feature", None, true).unwrap();
        write(&a, "f.txt", "feature");
        commit(&a_root, "Feature", true, false).unwrap();
        push(&a_root).unwrap();
        checkout(&a_root, &main, false).unwrap();

        run(dir.path().to_str().unwrap(), &["clone", remote, "b"]).unwrap();
        let b = Repository::open(dir.path().join("b")).unwrap();
        configure(&b);
        let b_root = root_of(&b);

        // A remote branch is checked out as a local one tracking it, once.
        checkout(&b_root, "origin/feature", true).unwrap();
        assert_eq!(current_branch(&b), "feature");
        assert!(b.find_branch("feature", BranchType::Local).unwrap().upstream().is_ok());
        checkout(&b_root, &main, false).unwrap();
        checkout(&b_root, "origin/feature", true).unwrap();
        assert_eq!(current_branch(&b), "feature");
        checkout(&b_root, &main, false).unwrap();

        // Someone pushes a commit, which a fetch learns of and a sync brings in.
        write(&b, "two.txt", "two");
        commit(&b_root, "Two", true, false).unwrap();
        push(&b_root).unwrap();
        fetch(&a_root).unwrap();
        assert_eq!(head_message(&a), "One\n");
        sync(&a_root).unwrap();
        assert_eq!(head_message(&a), "Two\n");

        create_tag(&a_root, "v1", None, None).unwrap();
        push_tags(&a_root).unwrap();
        assert!(bare.find_reference("refs/tags/v1").is_ok());

        delete_remote_branch(&b_root, "origin/feature").unwrap();
        assert!(bare.find_reference("refs/heads/feature").is_err());
    }

    #[test]
    fn reports_what_went_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_at(dir.path());
        let root = root_of(&repo);
        assert!(undo_commit(&root).is_err());
        write(&repo, "one.txt", "one");
        commit(&root, "One", true, false).unwrap();

        let err = push(&root).unwrap_err();
        assert!(err.contains("no remote"), "{err}");
        let err = pull(&root, false).unwrap_err();
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
