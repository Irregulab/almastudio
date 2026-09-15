//! Git reads backing the right-hand panel — status, diffs, the commit graph,
//! branches, stashes and tags — and staging, which is instant here. They run
//! against libgit2 in-process, so a refresh costs no process spawns;
//! refreshes are driven by the filesystem watcher rather than a timer.
//! Everything else that changes a repository, and everything that talks to a
//! remote, runs through the git command line in `git_cli`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{Delta, DiffOptions, Repository, Status, StatusOptions, StatusShow};
use serde::{Deserialize, Serialize};

/// Diffs larger than this are truncated; nobody reads a 40k-line diff and it
/// would cost tens of megabytes to ship into the webview.
const MAX_DIFF_LINES: usize = 20_000;

fn open(root: &str) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("not a git repository: {e}"))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    /// Two-letter porcelain-ish code, e.g. "M ", " M", "??", "A ", "MM".
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub detached: bool,
    pub files: Vec<ChangedFile>,
    /// "merge", "rebase", "cherry-pick", "revert" or "bisect" while one is
    /// under way, waiting on conflicts or a decision.
    pub operation: Option<&'static str>,
}

fn status_code(s: Status) -> String {
    if s.contains(Status::CONFLICTED) {
        return "UU".into();
    }
    if s.contains(Status::WT_NEW) && !s.intersects(Status::INDEX_NEW) {
        return "??".into();
    }
    let index = if s.contains(Status::INDEX_NEW) {
        'A'
    } else if s.contains(Status::INDEX_MODIFIED) {
        'M'
    } else if s.contains(Status::INDEX_DELETED) {
        'D'
    } else if s.contains(Status::INDEX_RENAMED) {
        'R'
    } else if s.contains(Status::INDEX_TYPECHANGE) {
        'T'
    } else {
        ' '
    };
    let work = if s.contains(Status::WT_NEW) {
        'A'
    } else if s.contains(Status::WT_MODIFIED) {
        'M'
    } else if s.contains(Status::WT_DELETED) {
        'D'
    } else if s.contains(Status::WT_RENAMED) {
        'R'
    } else if s.contains(Status::WT_TYPECHANGE) {
        'T'
    } else {
        ' '
    };
    format!("{index}{work}")
}

fn operation_of(repo: &Repository) -> Option<&'static str> {
    use git2::RepositoryState as State;
    Some(match repo.state() {
        State::Clean => return None,
        State::Merge => "merge",
        State::Revert | State::RevertSequence => "revert",
        State::CherryPick | State::CherryPickSequence => "cherry-pick",
        State::Bisect => "bisect",
        // Every flavour of rebase, and `git am`, which continues the same way.
        _ => "rebase",
    })
}

#[tauri::command]
pub fn git_status(root: String) -> Result<RepoStatus, String> {
    let repo = match open(&root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(RepoStatus {
                is_repo: false,
                root,
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                detached: false,
                files: vec![],
                operation: None,
            })
        }
    };

    let workdir = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());

    let mut opts = StatusOptions::new();
    opts.show(StatusShow::IndexAndWorkdir)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut files = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let s = entry.status();
        if s.is_empty() || s.contains(Status::IGNORED) {
            continue;
        }
        let path = entry
            .path()
            .ok()
            .map(|p| p.to_string())
            .or_else(|| {
                entry
                    .index_to_workdir()
                    .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().to_string()))
            })
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let old_path = entry
            .head_to_index()
            .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
            .filter(|p| p != &path);

        files.push(ChangedFile {
            code: status_code(s),
            staged: s.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            ),
            unstaged: s.intersects(
                Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE
                    | Status::WT_NEW,
            ),
            untracked: s.contains(Status::WT_NEW) && !s.contains(Status::INDEX_NEW),
            conflicted: s.contains(Status::CONFLICTED),
            deleted: s.intersects(Status::WT_DELETED | Status::INDEX_DELETED),
            old_path,
            path,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let head = repo.head().ok();
    let detached = repo.head_detached().unwrap_or(false);
    let branch = head.as_ref().and_then(|h| h.shorthand().ok().map(|s| s.to_string()));

    let (mut upstream, mut ahead, mut behind) = (None, 0usize, 0usize);
    if let Some(h) = head.as_ref() {
        if let Some(local_oid) = h.target() {
            if let Ok(local) = repo.find_branch(
                branch.as_deref().unwrap_or_default(),
                git2::BranchType::Local,
            ) {
                if let Ok(up) = local.upstream() {
                    upstream = up.name().ok().flatten().map(|s| s.to_string());
                    if let Some(up_oid) = up.get().target() {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
        }
    }

    Ok(RepoStatus {
        is_repo: true,
        root: workdir,
        branch,
        upstream,
        ahead,
        behind,
        detached,
        files,
        operation: operation_of(&repo),
    })
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// " " context, "+" addition, "-" deletion
    pub origin: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub additions: u32,
    pub deletions: u32,
    pub status: String,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffSide {
    /// index vs working tree (unstaged changes)
    Worktree,
    /// HEAD vs index (staged changes)
    Index,
    /// HEAD vs working tree (everything)
    Head,
}

fn delta_label(d: Delta) -> String {
    match d {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Untracked => "untracked",
        Delta::Conflicted => "conflicted",
        _ => "unmodified",
    }
    .to_string()
}

fn commit_of<'r>(repo: &'r Repository, rev: &str) -> Result<git2::Commit<'r>, String> {
    repo.revparse_single(rev)
        .and_then(|object| object.peel_to_commit())
        .map_err(|e| format!("unknown commit {rev}: {e}"))
}

fn tree_of<'r>(repo: &'r Repository, rev: &str) -> Result<git2::Tree<'r>, String> {
    commit_of(repo, rev)?.tree().map_err(|e| e.to_string())
}

/// One file's diff: the working tree's or the index's, per `side` — or, with
/// `target`, the change that commit made, against `base` or its first
/// parent. `old_path` pairs a renamed file with what it was called before.
#[tauri::command]
pub fn git_diff_file(
    root: String,
    path: String,
    side: DiffSide,
    context_lines: Option<u32>,
    old_path: Option<String>,
    base: Option<String>,
    target: Option<String>,
) -> Result<FileDiff, String> {
    let repo = open(&root)?;

    let mut opts = DiffOptions::new();
    opts.pathspec(&path)
        .context_lines(context_lines.unwrap_or(3))
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true);
    if let Some(old_path) = old_path.as_deref() {
        opts.pathspec(old_path);
    }

    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let diff = match target.as_deref() {
        Some(target) => {
            let new = tree_of(&repo, target)?;
            let old = match base.as_deref() {
                Some(base) => Some(tree_of(&repo, base)?),
                None => commit_of(&repo, target)?.parent(0).ok().and_then(|p| p.tree().ok()),
            };
            let mut diff = repo
                .diff_tree_to_tree(old.as_ref(), Some(&new), Some(&mut opts))
                .map_err(|e| e.to_string())?;
            diff.find_similar(None).map_err(|e| e.to_string())?;
            diff
        }
        None => match side {
            DiffSide::Worktree => repo.diff_index_to_workdir(None, Some(&mut opts)),
            DiffSide::Index => repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)),
            DiffSide::Head => {
                repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            }
        }
        .map_err(|e| e.to_string())?,
    };

    // libgit2 hands each callback its own `&mut` closure, so the accumulator
    // needs interior mutability to be shared between them.
    let out = RefCell::new(FileDiff {
        path: path.clone(),
        old_path: None,
        binary: false,
        truncated: false,
        additions: 0,
        deletions: 0,
        status: "unmodified".into(),
        hunks: vec![],
    });
    let total_lines = Cell::new(0usize);

    diff.foreach(
        &mut |delta, _| {
            let mut o = out.borrow_mut();
            o.status = delta_label(delta.status());
            o.binary = delta.new_file().is_binary() || delta.old_file().is_binary();
            if let Some(p) = delta.old_file().path() {
                let p = p.to_string_lossy().to_string();
                if p != path {
                    o.old_path = Some(p);
                }
            }
            true
        },
        None,
        Some(&mut |_, hunk| {
            out.borrow_mut().hunks.push(DiffHunk {
                header: String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
                lines: vec![],
            });
            true
        }),
        Some(&mut |_, _hunk, line| {
            let mut o = out.borrow_mut();
            if total_lines.get() >= MAX_DIFF_LINES {
                o.truncated = true;
                return true;
            }
            let origin = line.origin();
            // File-level markers ('F', 'H', 'B') carry no line content.
            if !matches!(origin, '+' | '-' | ' ') {
                return true;
            }
            match origin {
                '+' => o.additions += 1,
                '-' => o.deletions += 1,
                _ => {}
            }
            let content = String::from_utf8_lossy(line.content())
                .trim_end_matches(['\n', '\r'])
                .to_string();
            if let Some(h) = o.hunks.last_mut() {
                h.lines.push(DiffLine {
                    origin: origin.to_string(),
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content,
                });
                total_lines.set(total_lines.get() + 1);
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(out.into_inner())
}

// ---------------------------------------------------------------------------
// Commit details
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// The name before a rename.
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    /// The whole message, subject and body.
    pub message: String,
    pub author: String,
    pub email: String,
    /// Unix seconds.
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    /// What changed against the first parent; everything, for a root commit.
    pub files: Vec<CommitFile>,
}

/// The files that differ between two trees, with renames found the way
/// `git log --stat` finds them.
fn changed_files(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: Option<&git2::Tree>,
) -> Result<Vec<CommitFile>, String> {
    let mut opts = DiffOptions::new();
    opts.include_typechange(true);
    let mut diff = repo
        .diff_tree_to_tree(old, new, Some(&mut opts))
        .map_err(|e| e.to_string())?;
    diff.find_similar(None).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let path_of = |file: git2::DiffFile| file.path().map(|p| p.to_string_lossy().into_owned());
        let path = path_of(delta.new_file()).or_else(|| path_of(delta.old_file())).unwrap_or_default();
        let old_path = path_of(delta.old_file()).filter(|old| *old != path);
        // Counting lines needs the patch; a binary file has none to count.
        let (additions, deletions, binary) = match git2::Patch::from_diff(&diff, index) {
            Ok(Some(patch)) => {
                let binary = patch.delta().new_file().is_binary() || patch.delta().old_file().is_binary();
                let (_, added, removed) = patch.line_stats().unwrap_or((0, 0, 0));
                (added as u32, removed as u32, binary)
            }
            _ => (0, 0, true),
        };
        files.push(CommitFile {
            status: delta_label(delta.status()),
            path,
            old_path,
            additions,
            deletions,
            binary,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

#[tauri::command]
pub fn git_commit_details(root: String, id: String) -> Result<CommitDetails, String> {
    let repo = open(&root)?;
    let commit = commit_of(&repo, &id)?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let files = changed_files(&repo, parent_tree.as_ref(), Some(&tree))?;
    let (author, committer) = (commit.author(), commit.committer());
    let full = commit.id().to_string();
    Ok(CommitDetails {
        short_id: full.chars().take(7).collect(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        message: commit.message().unwrap_or("").trim_end().to_string(),
        author: author.name().unwrap_or("").to_string(),
        email: author.email().unwrap_or("").to_string(),
        author_time: author.when().seconds(),
        committer: committer.name().unwrap_or("").to_string(),
        committer_email: committer.email().unwrap_or("").to_string(),
        commit_time: committer.when().seconds(),
        files,
        id: full,
    })
}

/// What changed from `base` to `target`.
#[tauri::command]
pub fn git_compare_commits(
    root: String,
    base: String,
    target: String,
) -> Result<Vec<CommitFile>, String> {
    let repo = open(&root)?;
    let (old, new) = (tree_of(&repo, &base)?, tree_of(&repo, &target)?);
    changed_files(&repo, Some(&old), Some(&new))
}

// ---------------------------------------------------------------------------
// Partial staging
// ---------------------------------------------------------------------------

/// One hunk of a file's diff, or some of its lines, as a patch for `git apply`.
///
/// The diff is computed as `git_diff_file` shows it, with the same context, so
/// `hunk` and `lines` index what the user was looking at. `reverse` is for a
/// patch applied backwards (unstaging, discarding).
pub(crate) fn hunk_patch(
    root: &str,
    path: &str,
    side: DiffSide,
    context_lines: u32,
    hunk: usize,
    lines: Option<&[usize]>,
    reverse: bool,
) -> Result<String, String> {
    let repo = open(root)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .context_lines(context_lines)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true);
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = match side {
        DiffSide::Worktree => repo.diff_index_to_workdir(None, Some(&mut opts)),
        DiffSide::Index => repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)),
        DiffSide::Head => return Err("pick the working tree or staged view to change the index".into()),
    }
    .map_err(|e| e.to_string())?;
    let mut patch = git2::Patch::from_diff(&diff, 0)
        .map_err(|e| e.to_string())?
        .ok_or("the file has no changes here any more; refresh the diff")?;
    let buf = patch.to_buf().map_err(|e| e.to_string())?;
    let text = buf
        .as_str()
        .map_err(|_| "only part of a UTF-8 text file can be staged".to_string())?;
    select_hunk(text, hunk, lines, reverse)
}

/// The start lines and the rest of a hunk header, `@@ -12,7 +12,8 @@ fn x`.
fn parse_hunk_header(line: &str) -> Result<(u32, u32, &str), String> {
    let bad = || format!("unexpected hunk header: {}", line.trim_end());
    let inner = line.strip_prefix("@@ -").ok_or_else(bad)?;
    let (ranges, tail) = inner.split_once(" @@").ok_or_else(bad)?;
    let (old, new) = ranges.split_once(" +").ok_or_else(bad)?;
    let start = |range: &str| range.split(',').next().and_then(|n| n.parse().ok()).ok_or_else(bad);
    Ok((start(old)?, start(new)?, tail))
}

/// Cuts one hunk out of a file's patch. With `lines` only those changed lines
/// are kept, and the others become what the patch must still find: applied
/// forwards an unchosen addition goes and an unchosen removal stays as
/// context, backwards the other way round. The counts are worked out anew.
fn select_hunk(patch: &str, hunk: usize, lines: Option<&[usize]>, reverse: bool) -> Result<String, String> {
    let mut header = String::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@") {
            hunks.push(vec![line]);
        } else if let Some(current) = hunks.last_mut() {
            current.push(line);
        } else {
            header.push_str(line);
        }
    }
    let body = hunks.get(hunk).ok_or("that hunk is no longer in the diff; refresh it")?;
    let (old_start, new_start, tail) = parse_hunk_header(body[0])?;

    let mut out = String::new();
    let (mut old_count, mut new_count) = (0u32, 0u32);
    let mut index = 0;
    let mut changed = false;
    let mut kept_previous = true;
    for line in &body[1..] {
        // "\ No newline at end of file" belongs to the line before it.
        if line.starts_with('\\') {
            if kept_previous {
                out.push_str(line);
            }
            continue;
        }
        let chosen = lines.is_none_or(|chosen| chosen.contains(&index));
        index += 1;
        let origin = line.as_bytes().first().copied().unwrap_or(b' ');
        let kept = match origin {
            b'+' | b'-' if chosen => {
                changed = true;
                Some(origin)
            }
            b'+' if !reverse => None,
            b'-' if reverse => None,
            _ => Some(b' '),
        };
        kept_previous = kept.is_some();
        let Some(origin) = kept else { continue };
        match origin {
            b'+' => new_count += 1,
            b'-' => old_count += 1,
            _ => {
                old_count += 1;
                new_count += 1;
            }
        }
        out.push(origin as char);
        out.push_str(line.get(1..).unwrap_or(""));
    }
    if !changed {
        return Err("none of the chosen lines is a change".into());
    }
    Ok(format!("{header}@@ -{old_start},{old_count} +{new_start},{new_count} @@{tail}{out}"))
}

// ---------------------------------------------------------------------------
// Staging and discarding
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&root)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let workdir = repo.workdir().map(PathBuf::from).unwrap_or_default();
    for p in &paths {
        let rel = Path::new(p);
        if workdir.join(rel).exists() {
            index.add_path(rel).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(rel).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&root)?;
    // Bind the peeled commit before matching: as a match scrutinee its
    // temporary would outlive `repo` and fail to borrow-check.
    let head_commit = repo.head().ok().and_then(|h| h.peel(git2::ObjectType::Commit).ok());
    match head_commit {
        Some(head_commit) => repo
            .reset_default(Some(&head_commit), paths.iter().map(Path::new))
            .map_err(|e| e.to_string()),
        None => {
            // No commits yet: unstaging means removing from the index entirely.
            let mut index = repo.index().map_err(|e| e.to_string())?;
            for p in &paths {
                index.remove_path(Path::new(p)).map_err(|e| e.to_string())?;
            }
            index.write().map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&root)?;
    let workdir = repo.workdir().map(PathBuf::from).unwrap_or_default();

    // Untracked files have nothing to check out; they are simply removed.
    let mut tracked: Vec<&String> = vec![];
    for p in &paths {
        let is_untracked = repo
            .status_file(Path::new(p))
            .map(|s| s.contains(Status::WT_NEW) && !s.contains(Status::INDEX_NEW))
            .unwrap_or(false);
        if is_untracked {
            let _ = std::fs::remove_file(workdir.join(p));
        } else {
            tracked.push(p);
        }
    }
    if tracked.is_empty() {
        return Ok(());
    }

    let mut co = git2::build::CheckoutBuilder::new();
    co.force().remove_untracked(false);
    for p in &tracked {
        co.path(p.as_str());
    }
    repo.checkout_head(Some(&mut co)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// History and branches
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// "branch", "remote", "tag", or "head" for a detached HEAD.
    pub kind: &'static str,
    /// The branch checked out, or a detached HEAD.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author: String,
    pub email: String,
    /// Unix seconds.
    pub time: i64,
    /// Branches and tags pointing at this commit.
    pub refs: Vec<RefLabel>,
}

/// History across every local and remote branch and tag, for the commit
/// graph: each commit listed before its parents, newest first otherwise, with
/// the refs that point at it. `refs`, full ref names, limits the history to
/// those branches and HEAD; every label is shown either way.
#[tauri::command]
pub fn git_graph(
    root: String,
    limit: Option<usize>,
    refs: Option<Vec<String>>,
) -> Result<Vec<GraphCommit>, String> {
    let repo = open(&root)?;
    let limit = limit.unwrap_or(200).min(5000);
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let head = repo.head().ok();
    let head_branch = head
        .as_ref()
        .filter(|h| h.is_branch())
        .and_then(|h| h.name().ok())
        .map(String::from);
    let mut labels: HashMap<git2::Oid, Vec<RefLabel>> = HashMap::new();
    let mut tips = 0;

    for reference in repo.references().map_err(|e| e.to_string())?.flatten() {
        let Ok(name) = reference.name() else { continue };
        let (kind, short) = if let Some(short) = name.strip_prefix("refs/heads/") {
            ("branch", short)
        } else if let Some(short) = name.strip_prefix("refs/remotes/") {
            // origin/HEAD only repeats which branch the remote considers main.
            if short.ends_with("/HEAD") {
                continue;
            }
            ("remote", short)
        } else if let Some(short) = name.strip_prefix("refs/tags/") {
            ("tag", short)
        } else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else { continue };
        let wanted = refs.as_ref().is_none_or(|wanted| wanted.iter().any(|r| r == name));
        if wanted && walk.push(commit.id()).is_ok() {
            tips += 1;
        }
        labels.entry(commit.id()).or_default().push(RefLabel {
            name: short.to_string(),
            kind,
            current: head_branch.as_deref() == Some(name),
        });
    }
    if let Some(commit) = head.as_ref().and_then(|h| h.peel_to_commit().ok()) {
        if walk.push(commit.id()).is_ok() {
            tips += 1;
        }
        if head_branch.is_none() {
            labels.entry(commit.id()).or_default().push(RefLabel {
                name: "HEAD".into(),
                kind: "head",
                current: true,
            });
        }
    }
    if tips == 0 {
        return Ok(vec![]);
    }

    let rank = |kind: &str| match kind {
        "head" => 0,
        "branch" => 1,
        "remote" => 2,
        _ => 3,
    };
    let mut out = Vec::new();
    for oid in walk.take(limit) {
        let Ok(oid) = oid else { continue };
        let Ok(c) = repo.find_commit(oid) else { continue };
        let mut refs = labels.remove(&oid).unwrap_or_default();
        // The checked-out branch first, then branches, remote ones, tags.
        refs.sort_by(|a, b| {
            (!a.current, rank(a.kind), &a.name).cmp(&(!b.current, rank(b.kind), &b.name))
        });
        let id = oid.to_string();
        out.push(GraphCommit {
            short_id: id.chars().take(7).collect(),
            parents: c.parent_ids().map(|p| p.to_string()).collect(),
            summary: c.summary().ok().flatten().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            email: c.author().email().unwrap_or("").to_string(),
            time: c.time().seconds(),
            refs,
            id,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<BranchInfo>, String> {
    let repo = open(&root)?;
    let mut out = vec![];
    let branches = repo.branches(None).map_err(|e| e.to_string())?;
    for b in branches.flatten() {
        let (branch, kind) = b;
        if let Ok(Some(name)) = branch.name() {
            out.push(BranchInfo {
                name: name.to_string(),
                is_head: branch.is_head(),
                is_remote: matches!(kind, git2::BranchType::Remote),
            });
        }
    }
    out.sort_by(|a, b| (a.is_remote, a.name.clone()).cmp(&(b.is_remote, b.name.clone())));
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// Position in the stash list: `stash@{index}`.
    pub index: usize,
    pub message: String,
    pub id: String,
    /// Unix seconds.
    pub time: i64,
}

#[tauri::command]
pub fn git_stashes(root: String) -> Result<Vec<StashInfo>, String> {
    let mut repo = open(&root)?;
    let mut found = Vec::new();
    repo.stash_foreach(|index, message, id| {
        found.push((index, message.to_string(), *id));
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|(index, message, id)| StashInfo {
            time: repo.find_commit(id).map(|c| c.time().seconds()).unwrap_or(0),
            id: id.to_string(),
            index,
            message,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// The commit it points at, abbreviated.
    pub target: String,
}

#[tauri::command]
pub fn git_tags(root: String) -> Result<Vec<TagInfo>, String> {
    let repo = open(&root)?;
    let names = repo.tag_names(None).map_err(|e| e.to_string())?;
    let mut tags: Vec<TagInfo> = names
        .iter()
        .flatten()
        .flatten()
        .map(|name| TagInfo {
            target: repo
                .revparse_single(&format!("refs/tags/{name}"))
                .and_then(|object| object.peel_to_commit())
                .map(|commit| commit.id().to_string().chars().take(7).collect())
                .unwrap_or_default(),
            name: name.to_string(),
        })
        .collect();
    tags.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tags)
}

// ------------------------------------------------------- repo discovery ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub path: String,
    pub name: String,
    /// Path relative to the folder that was searched.
    pub rel: String,
    pub branch: Option<String>,
    /// Number of changed files, so the list is useful at a glance.
    pub dirty: usize,
}

/// Directories that never contain a project worth listing and are expensive
/// to walk.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo", ".venv",
    "venv", "__pycache__", "vendor", "Pods", ".gradle", ".cache", "Library",
];

/// Finds git repositories beneath `root`.
///
/// This is what makes a folder full of projects usable: point AlmaStudio at
/// `~/git` and the panel can still show you which repository you mean, rather
/// than reporting that the folder itself is not one. A found repository is not
/// descended into — nested repositories are almost always submodules, and
/// walking them would multiply the cost for no benefit.
#[tauri::command]
pub fn find_git_repos(root: String, max_depth: Option<usize>) -> Result<Vec<RepoEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let max_depth = max_depth.unwrap_or(3).min(6);
    const MAX_RESULTS: usize = 60;

    let mut found: Vec<PathBuf> = Vec::new();
    // Breadth-first, so the nearest repositories are reported first.
    let mut frontier = vec![(root_path.clone(), 0usize)];

    while let Some((dir, depth)) = frontier.pop() {
        if found.len() >= MAX_RESULTS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut children = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            // `.git` is a directory in a normal clone and a file in a worktree
            // or submodule, so its mere presence is the signal.
            if name == ".git" {
                found.push(dir.clone());
                children.clear();
                break;
            }
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if depth < max_depth {
                children.push((path, depth + 1));
            }
        }
        frontier.extend(children);
    }

    found.sort();
    found.dedup();

    let mut out = Vec::with_capacity(found.len());
    for path in found {
        // Opening each repository is cheap and the branch is the single most
        // useful thing to show next to its name.
        let branch = Repository::open(&path)
            .ok()
            .and_then(|r| r.head().ok().and_then(|h| h.shorthand().ok().map(String::from)));
        let dirty = Repository::open(&path)
            .ok()
            .and_then(|r| {
                let mut opts = StatusOptions::new();
                opts.include_untracked(true).include_ignored(false);
                r.statuses(Some(&mut opts)).ok().map(|s| s.len())
            })
            .unwrap_or(0);

        out.push(RepoEntry {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            rel: path
                .strip_prefix(&root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
            path: path.to_string_lossy().to_string(),
            branch,
            dirty,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Signature};

    fn commit_on(repo: &Repository, refname: &str, message: &str, parents: &[Oid]) -> Oid {
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
        let parents: Vec<git2::Commit> =
            parents.iter().map(|id| repo.find_commit(*id).unwrap()).collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some(refname), &sig, &sig, message, &tree, &parents).unwrap()
    }

    #[test]
    fn graph_lists_every_branch_children_first_with_labels() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit_on(&repo, "HEAD", "root", &[]);
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let main_work = commit_on(&repo, "HEAD", "main work", &[root]);
        let feature = commit_on(&repo, "refs/heads/feature", "feature work", &[root]);
        let merge = commit_on(&repo, "HEAD", "merge feature", &[main_work, feature]);
        commit_on(&repo, "refs/heads/side", "side work", &[merge]);
        repo.tag_lightweight("v1", &repo.find_object(root, None).unwrap(), false).unwrap();

        let graph = git_graph(dir.path().to_string_lossy().into_owned(), None, None).unwrap();
        assert_eq!(graph.len(), 5);
        let at = |summary: &str| graph.iter().position(|c| c.summary == summary).unwrap();
        assert!(at("side work") < at("merge feature"));
        assert!(at("merge feature") < at("main work") && at("merge feature") < at("feature work"));
        assert!(at("main work") < at("root") && at("feature work") < at("root"));
        assert_eq!(graph[at("merge feature")].parents, [main_work.to_string(), feature.to_string()]);

        let labels = |summary: &str| -> Vec<String> {
            graph[at(summary)]
                .refs
                .iter()
                .map(|r| format!("{}:{}{}", r.kind, r.name, if r.current { "*" } else { "" }))
                .collect()
        };
        assert_eq!(labels("merge feature"), [format!("branch:{branch}*")]);
        assert_eq!(labels("side work"), ["branch:side"]);
        assert_eq!(labels("feature work"), ["branch:feature"]);
        assert_eq!(labels("root"), ["tag:v1"]);
        assert!(labels("main work").is_empty());
    }

    #[test]
    fn graph_of_a_repository_without_commits_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        Repository::init(dir.path()).unwrap();
        assert!(git_graph(dir.path().to_string_lossy().into_owned(), None, None).unwrap().is_empty());
    }

    fn commit_change(repo: &Repository, message: &str, write: &[(&str, &str)], remove: &[&str]) -> Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        let mut index = repo.index().unwrap();
        for (path, body) in write {
            std::fs::write(workdir.join(path), body).unwrap();
            index.add_path(Path::new(path)).unwrap();
        }
        for path in remove {
            std::fs::remove_file(workdir.join(path)).unwrap();
            index.remove_path(Path::new(path)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap()
    }

    #[test]
    fn commit_details_list_what_each_commit_changed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let moved = "the same text\nkept across a rename\n";
        let first = commit_change(&repo, "First\n\nBody text", &[("a.txt", "one\ntwo\n"), ("old.txt", moved)], &[]);
        let second = commit_change(&repo, "Second", &[("a.txt", "one\n2\nthree\n"), ("new.txt", moved)], &["old.txt"]);

        let details = git_commit_details(root.clone(), first.to_string()).unwrap();
        assert_eq!(details.message, "First\n\nBody text");
        assert!(details.parents.is_empty());
        let files: Vec<String> = details
            .files
            .iter()
            .map(|f| format!("{} {} +{} -{}", f.status, f.path, f.additions, f.deletions))
            .collect();
        assert_eq!(files, ["added a.txt +2 -0", "added old.txt +2 -0"]);

        let details = git_commit_details(root.clone(), second.to_string()).unwrap();
        assert_eq!(details.parents, [first.to_string()]);
        let files: Vec<String> = details
            .files
            .iter()
            .map(|f| format!("{} {} {:?} +{} -{}", f.status, f.path, f.old_path, f.additions, f.deletions))
            .collect();
        assert_eq!(files, ["modified a.txt None +2 -1", "renamed new.txt Some(\"old.txt\") +0 -0"]);

        assert_eq!(git_compare_commits(root.clone(), first.to_string(), second.to_string()).unwrap().len(), 2);

        let diff = git_diff_file(root.clone(), "a.txt".into(), DiffSide::Head, None, None, None, Some(second.to_string())).unwrap();
        assert_eq!((diff.additions, diff.deletions), (2, 1));
        let diff = git_diff_file(
            root.clone(), "new.txt".into(), DiffSide::Head, None, Some("old.txt".into()), None, Some(second.to_string()),
        )
        .unwrap();
        assert_eq!(diff.status, "renamed");
        assert_eq!(diff.old_path.as_deref(), Some("old.txt"));
        // Against an explicit base: the first commit added a.txt from nothing.
        let diff = git_diff_file(root, "a.txt".into(), DiffSide::Head, None, None, None, Some(first.to_string())).unwrap();
        assert_eq!((diff.additions, diff.deletions), (2, 0));
    }

    #[test]
    fn graph_can_be_limited_to_some_branches() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit_on(&repo, "HEAD", "root", &[]);
        commit_on(&repo, "refs/heads/feature", "feature work", &[root]);
        commit_on(&repo, "refs/heads/other", "other work", &[root]);
        let summaries = |refs: Option<Vec<String>>| -> Vec<String> {
            git_graph(dir.path().to_string_lossy().into_owned(), None, refs)
                .unwrap()
                .into_iter()
                .map(|c| c.summary)
                .collect()
        };
        assert_eq!(summaries(None).len(), 3);
        // HEAD stays in, so its commit does.
        assert_eq!(summaries(Some(vec!["refs/heads/feature".into()])), ["feature work", "root"]);
    }

    const PATCH: &str = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@ top\n a\n-b\n+B\n+C\n d\n@@ -10,2 +11,2 @@\n x\n-y\n+Y\n";

    #[test]
    fn a_hunk_becomes_a_patch_of_its_own() {
        assert_eq!(
            select_hunk(PATCH, 1, None, false).unwrap(),
            "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -10,2 +11,2 @@\n x\n-y\n+Y\n",
        );
    }

    #[test]
    fn unchosen_lines_are_dropped_or_kept_as_context() {
        // Staging only "+B": the removal stays as context and "+C" goes.
        let staged = select_hunk(PATCH, 0, Some(&[2]), false).unwrap();
        assert!(staged.ends_with("@@ -1,3 +1,4 @@ top\n a\n b\n+B\n d\n"), "{staged}");
        // Unstaging only "-b": the additions stay as context.
        let unstaged = select_hunk(PATCH, 0, Some(&[1]), true).unwrap();
        assert!(unstaged.ends_with("@@ -1,5 +1,4 @@ top\n a\n-b\n B\n C\n d\n"), "{unstaged}");
    }

    #[test]
    fn a_missing_newline_note_goes_with_its_line() {
        let patch = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
        assert_eq!(
            select_hunk(patch, 0, Some(&[0]), false).unwrap(),
            "--- a/f\n+++ b/f\n@@ -1,1 +1,0 @@\n-old\n\\ No newline at end of file\n",
        );
    }

    #[test]
    fn nothing_to_apply_is_refused() {
        assert!(select_hunk(PATCH, 0, Some(&[0]), false).is_err());
        assert!(select_hunk(PATCH, 5, None, false).is_err());
    }
}
