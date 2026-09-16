//! Which AI harnesses can actually be run on this machine. One whose command
//! is not installed is left out of the menus, as an editor that is not
//! installed is — see `editors`.

use std::path::{Path, PathBuf};

use crate::git_cli::login_path;

/// Those of `commands` that can be run, in the order given.
#[tauri::command]
pub async fn installed_harnesses(commands: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        commands.into_iter().filter(|c| resolve(c).is_some()).collect()
    })
    .await
    .unwrap_or_default()
}

/// What a command name runs, if anything. It is looked up on the login
/// shell's PATH — the PATH a tab's program is started with — rather than on
/// the bare one the app itself was launched with.
fn resolve(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    // A path, absolute or relative, is run as given rather than looked up.
    if command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        return runnable(Path::new(command));
    }
    search_dirs()
        .iter()
        .flat_map(|dir| names(command).into_iter().map(|name| dir.join(name)))
        .find_map(|candidate| runnable(&candidate))
}

/// The login shell's PATH first, then Homebrew's and the system's usual
/// places, then the PATH this process was given.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = login_path()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs
}

/// The file names a command can be installed under. On Windows what runs is
/// the command plus one of the PATHEXT extensions: an npm install leaves
/// `claude.cmd` on the PATH, never a bare `claude`.
fn names(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut names = vec![command.to_string()];
        names.extend(
            exts.split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!("{command}{e}")),
        );
        names
    }
    #[cfg(not(windows))]
    {
        vec![command.to_string()]
    }
}

fn runnable(path: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path.to_path_buf())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn finds_a_command_on_the_path_and_not_one_that_is_missing() {
        assert!(resolve("sh").is_some());
        assert!(resolve("almastudio-no-such-harness").is_none());
        assert!(resolve("   ").is_none());
    }

    #[test]
    fn takes_a_path_as_it_is() {
        assert!(resolve("/bin/sh").is_some());
        assert!(resolve("/bin/sh/nope").is_none());
        // A folder, and a file nothing can execute, are not commands.
        assert!(resolve("/bin").is_none());
        assert!(resolve("/etc/hosts").is_none());
    }
}
