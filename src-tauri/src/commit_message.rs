//! Commit messages written by an AI harness the user already has: the changes
//! about to be committed go to Claude Code, Codex or OpenCode run headless —
//! no API key of its own, no terminal tab, nothing on screen — and what it
//! answers is put in the commit box.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::git_cli::{command_path, feed, finish, hide_window, output};
use crate::harness::resolve;

/// A harness answers in seconds; one that hangs is given up on.
const TIMEOUT: Duration = Duration::from_secs(180);

/// How much of the diff is sent. Past this the harness gets the summary of
/// every file plus the start of the patch, which is enough for a message.
const MAX_DIFF: usize = 60_000;

/// An untracked file's content is shown up to this size; past it, only its
/// name.
const MAX_NEW_FILE: u64 = 16_000;

#[tauri::command]
pub async fn generate_commit_message(
    root: String,
    harness: String,
    command: String,
    staged_only: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate(&root, &harness, &command, staged_only))
        .await
        .map_err(|e| e.to_string())?
}

fn generate(root: &str, harness: &str, command: &str, staged_only: bool) -> Result<String, String> {
    let diff = changes(root, staged_only)?;
    if diff.trim().is_empty() {
        return Err("there are no changes to describe".into());
    }
    let subjects = output(root, &["log", "-n", "12", "--no-color", "--format=%s"]).unwrap_or_default();
    let prompt = prompt(&diff, &subjects);
    let program = resolve(command).ok_or_else(|| format!("{command} was not found"))?;

    let message = match harness {
        // No tools at all, and no session left behind in its history.
        "claude" => run(
            &program,
            root,
            &["-p", "--output-format", "text", "--no-session-persistence", "--tools", ""],
            &prompt,
        )?,
        "codex" => codex(&program, root, &prompt)?,
        "opencode" => opencode_text(&run(&program, root, &["run", "--format", "json"], &prompt)?)?,
        other => return Err(format!("{other} cannot write commit messages")),
    };
    let message = clean(&message);
    if message.is_empty() {
        return Err(format!("{harness} returned an empty message"));
    }
    Ok(message)
}

/// Codex prints its progress as it works; the answer alone is what it writes
/// to the `--output-last-message` file.
fn codex(program: &Path, root: &str, prompt: &str) -> Result<String, String> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let file = std::env::temp_dir().join(format!("almastudio-commit-{}-{nonce}.txt", std::process::id()));
    let file_arg = file.to_string_lossy().into_owned();
    let printed = run(
        program,
        root,
        &[
            "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
            "--color", "never", "--output-last-message", &file_arg, "-",
        ],
        prompt,
    );
    let written = std::fs::read_to_string(&file).ok();
    let _ = std::fs::remove_file(&file);
    let printed = printed?;
    Ok(written.filter(|w| !w.trim().is_empty()).unwrap_or(printed))
}

/// OpenCode's JSON events, one per line: the answer is its text parts, an
/// error event says what went wrong.
fn opencode_text(events: &str) -> Result<String, String> {
    let mut text = Vec::new();
    for line in events.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match event["type"].as_str() {
            Some("text") => {
                if let Some(t) = event["part"]["text"].as_str() {
                    text.push(t.to_string());
                }
            }
            Some("error") => {
                let message = event["error"]["message"].as_str().unwrap_or("opencode failed");
                return Err(message.to_string());
            }
            _ => {}
        }
    }
    // Text written before a tool call is commentary; the last part is the
    // answer.
    text.pop().ok_or_else(|| "opencode returned no message".to_string())
}

/// Runs a harness in the repository with `prompt` on its stdin, hidden.
/// What it printed on stdout on success; the end of what it said otherwise.
fn run(program: &Path, root: &str, args: &[&str], prompt: &str) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .current_dir(root)
        .args(args)
        // Plain text: nothing here renders colours or reads a terminal.
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = command_path() {
        // npm-installed harnesses are scripts that need `node` on the PATH.
        command.env("PATH", path);
    }
    hide_window(&mut command);
    let name = program.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = command.spawn().map_err(|e| format!("could not run {name}: {e}"))?;
    feed(&mut child, prompt);
    let (status, out, err) = finish(child, TIMEOUT).map_err(|e| format!("{name} {e}"))?;
    if status.success() {
        return Ok(out);
    }
    // OpenCode reports a failure as a JSON event on stdout.
    if out.contains(r#""type":"error""#) {
        opencode_text(&out)?;
    }
    let said = last_lines(&strip_ansi(&err), 6);
    let said = if said.is_empty() { last_lines(&strip_ansi(&out), 6) } else { said };
    Err(if said.is_empty() { format!("{name} failed ({status})") } else { said })
}

/// What is about to be committed, as the commit box decides it: the staged
/// changes, or every change — untracked files included — when nothing is.
fn changes(root: &str, staged_only: bool) -> Result<String, String> {
    let diff = |extra: &[&str]| {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--find-renames"];
        args.extend_from_slice(extra);
        output(root, &args)
    };
    if staged_only {
        let stat = diff(&["--cached", "--stat"])?;
        return Ok(join(&stat, &diff(&["--cached"])?));
    }

    let born = output(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
    let (stat, patch) = if born {
        (diff(&["HEAD", "--stat"])?, diff(&["HEAD"])?)
    } else {
        // No commit to compare with yet: what is staged plus what is not.
        (
            join(&diff(&["--cached", "--stat"])?, &diff(&["--stat"])?),
            join(&diff(&["--cached"])?, &diff(&[])?),
        )
    };
    let untracked = output(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut added = String::new();
    for path in untracked.split('\0').filter(|p| !p.is_empty()) {
        added.push_str(&new_file(Path::new(root), path));
    }
    Ok(join(&stat, &join(&patch, &added)))
}

/// An untracked file written as the patch that would add it.
fn new_file(root: &Path, path: &str) -> String {
    let full: PathBuf = root.join(path);
    let header = format!("diff --git a/{path} b/{path}\nnew file\n--- /dev/null\n+++ b/{path}\n");
    let small = std::fs::metadata(&full).map(|m| m.is_file() && m.len() <= MAX_NEW_FILE).unwrap_or(false);
    match small.then(|| std::fs::read_to_string(&full).ok()).flatten() {
        Some(text) => {
            let body: String = text.lines().map(|l| format!("+{l}\n")).collect();
            format!("{header}{body}")
        }
        None => format!("{header}(binary or large file, content not shown)\n"),
    }
}

fn join(a: &str, b: &str) -> String {
    match (a.trim().is_empty(), b.trim().is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{}\n\n{b}", a.trim_end()),
    }
}

fn prompt(diff: &str, subjects: &str) -> String {
    let mut diff = diff.to_string();
    if diff.len() > MAX_DIFF {
        let mut cut = MAX_DIFF;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
        diff.push_str("\n[… the rest of the diff is left out …]\n");
    }
    let style = if subjects.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\nThe subjects of this repository's latest commits are below: follow \
             their style, conventions (such as prefixes) and language.\n\n\
             <recent-commits>\n{}\n</recent-commits>\n",
            subjects.trim()
        )
    };
    format!(
        "You write git commit messages. Write the commit message for the changes \
         in the diff below.\n\n\
         - A subject line in the imperative mood, at most 72 characters, with no \
         trailing period.\n\
         - Only if the change needs explaining: a blank line, then a short body \
         wrapped at 72 columns that says what changed and why.\n\
         - Reply with the commit message alone: no preamble, no quotes, no code \
         fences, no Markdown. Do not run any tools or commands; everything you \
         need is here.\n{style}\n<diff>\n{diff}\n</diff>\n"
    )
}

/// The message without what a model wraps around one: surrounding blank
/// lines, a code fence, trailing spaces.
fn clean(text: &str) -> String {
    let mut lines: Vec<&str> = text.trim().lines().map(str::trim_end).collect();
    if lines.first().is_some_and(|l| l.starts_with("```")) && lines.last().is_some_and(|l| l.trim() == "```") {
        lines = lines[1..lines.len().saturating_sub(1)].to_vec();
    }
    lines.join("\n").trim().to_string()
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Text without the terminal escape sequences a CLI colours its errors with.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // Parameters up to the final byte, a letter.
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_last_text_part_of_opencode_events() {
        let events = concat!(
            r#"{"type":"step_start","part":{"type":"step-start"}}"#, "\n",
            r#"{"type":"text","part":{"type":"text","text":"Looking at it"}}"#, "\n",
            r#"{"type":"text","part":{"type":"text","text":"Fix the thing"}}"#, "\n",
        );
        assert_eq!(opencode_text(events).unwrap(), "Fix the thing");
        let error = r#"{"type":"error","error":{"message":"Add credits to continue"}}"#;
        assert_eq!(opencode_text(error).unwrap_err(), "Add credits to continue");
        assert!(opencode_text("").is_err());
    }

    #[test]
    fn unwraps_a_fenced_message() {
        assert_eq!(clean("\n```\nAdd a button  \n\nWhy it matters\n```\n"), "Add a button\n\nWhy it matters");
        assert_eq!(clean("  Add a button\n"), "Add a button");
    }

    #[test]
    fn strips_colours() {
        assert_eq!(strip_ansi("\x1b[91m\x1b[1mError: \x1b[0mno credit"), "Error: no credit");
    }

    #[test]
    fn cuts_a_long_diff_on_a_character_boundary() {
        let diff = "é".repeat(MAX_DIFF);
        let p = prompt(&diff, "");
        assert!(p.contains("left out"));
        assert!(!p.contains("<recent-commits>"));
        assert!(prompt("x", "Add a thing").contains("Add a thing"));
    }

    /// Asks the harnesses installed here for a real message; run with
    /// `cargo test -- --ignored live_` to try them.
    #[test]
    #[ignore]
    fn live_harnesses_write_a_message() {
        let dir = std::env::temp_dir().join(format!("almastudio-commit-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        output(&root, &["init", "-q"]).unwrap();
        std::fs::write(dir.join("greet.py"), "def greet(name):\n    return f'Hello, {name}!'\n").unwrap();
        for harness in ["claude", "codex", "opencode"] {
            match generate(&root, harness, harness, false) {
                Ok(message) => eprintln!("{harness}: {message:?}"),
                Err(e) => eprintln!("{harness} failed: {e}"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
