//! Local git operations backing the right-hand panel: status, diffs, staging
//! and the commit graph. Everything runs against libgit2 in-process, so a
//! refresh costs no process spawns; refreshes are driven by the filesystem
//! watcher rather than a timer. Fetch, pull and push, which need the network,
//! are in `git_remote`.

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

#[tauri::command]
pub fn git_diff_file(
    root: String,
    path: String,
    side: DiffSide,
    context_lines: Option<u32>,
) -> Result<FileDiff, String> {
    let repo = open(&root)?;

    let mut opts = DiffOptions::new();
    opts.pathspec(&path)
        .context_lines(context_lines.unwrap_or(3))
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true);

    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let diff = match side {
        DiffSide::Worktree => repo.diff_index_to_workdir(None, Some(&mut opts)),
        DiffSide::Index => repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)),
        DiffSide::Head => repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)),
    }
    .map_err(|e| e.to_string())?;

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
// Staging / discarding / committing
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

#[tauri::command]
pub fn git_commit(root: String, message: String, stage_all: bool) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("empty commit message".into());
    }
    let repo = open(&root)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    if stage_all {
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
    }

    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = repo
        .signature()
        .map_err(|_| "git user.name / user.email are not configured".to_string())?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
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
/// the refs that point at it.
#[tauri::command]
pub fn git_graph(root: String, limit: Option<usize>) -> Result<Vec<GraphCommit>, String> {
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
        if walk.push(commit.id()).is_ok() {
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

#[tauri::command]
pub fn git_checkout(root: String, name: String) -> Result<(), String> {
    let repo = open(&root)?;
    let (object, reference) = repo
        .revparse_ext(&name)
        .map_err(|e| format!("unknown revision {name}: {e}"))?;
    repo.checkout_tree(&object, None).map_err(|e| e.to_string())?;
    let refname = reference.and_then(|r| r.name().ok().map(String::from));
    match refname {
        Some(refname) => repo.set_head(&refname).map_err(|e| e.to_string()),
        None => repo.set_head_detached(object.id()).map_err(|e| e.to_string()),
    }
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

        let graph = git_graph(dir.path().to_string_lossy().into_owned(), None).unwrap();
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
        assert!(git_graph(dir.path().to_string_lossy().into_owned(), None).unwrap().is_empty());
    }
}
