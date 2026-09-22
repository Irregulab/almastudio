//! Filesystem access for the "all files" tree, the quick file finder and the
//! file viewer. Listing is lazy — one directory level per call — so opening a
//! monorepo costs the same as opening a toy project.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use ignore::WalkBuilder;
use serde::Serialize;

/// Above this a file is shown as "too large to display" rather than shipped
/// into the webview.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
static WRITE_TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// Path relative to the project root, using forward slashes.
    pub rel: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

fn to_rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// The dot entries of `dir` that the gitignore filter dropped. Showing hidden
/// files is asked for to see `.env` and its kind, which are almost always
/// gitignored, so a gitignore rule must not hide them again. `.git` stays
/// out, and so does anything already in `listed`.
fn ignored_dot_entries(
    root: &Path,
    dir: &Path,
    listed: &HashSet<PathBuf>,
    dirs_too: bool,
) -> Vec<DirEntryInfo> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            if !name.starts_with('.') || name == ".git" || listed.contains(&path) {
                return None;
            }
            // Not followed through symlinks, as the walker does not follow them.
            let meta = e.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            if is_dir && !dirs_too {
                return None;
            }
            Some(DirEntryInfo {
                rel: to_rel(root, &path),
                is_symlink: e.file_type().map(|t| t.is_symlink()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                path: path.to_string_lossy().to_string(),
                name,
                is_dir,
            })
        })
        .collect()
}

#[tauri::command]
pub fn list_dir(
    root: String,
    dir: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> Result<Vec<DirEntryInfo>, String> {
    // `root` is whatever folder the panel is currently inspecting — a project
    // folder, or any other directory a tab was opened in. Canonicalise both
    // sides so that symlinked roots (/tmp on macOS) still compare equal.
    let root_path = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let dir_path = if dir.is_empty() {
        root_path.clone()
    } else {
        fs::canonicalize(&dir).unwrap_or_else(|_| PathBuf::from(&dir))
    };

    if !dir_path.starts_with(&root_path) {
        return Err("path is outside the folder being browsed".into());
    }
    if !dir_path.is_dir() {
        return Err(format!("not a directory: {}", dir_path.display()));
    }

    let mut builder = WalkBuilder::new(&dir_path);
    builder
        .max_depth(Some(1))
        .hidden(!show_hidden)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .ignore(respect_gitignore)
        .parents(respect_gitignore)
        .follow_links(false);

    let mut out = Vec::new();
    for entry in builder.build().flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path().to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        // `.git` is noise in a file tree even when hidden files are shown.
        if name == ".git" {
            continue;
        }
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        out.push(DirEntryInfo {
            rel: to_rel(&root_path, &path),
            is_symlink: entry.path_is_symlink(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            path: path.to_string_lossy().to_string(),
            name,
            is_dir,
        });
    }
    if show_hidden && respect_gitignore {
        let listed: HashSet<PathBuf> = out.iter().map(|e| PathBuf::from(&e.path)).collect();
        out.extend(ignored_dot_entries(&root_path, &dir_path, &listed, true));
    }

    // Directories first, then case-insensitive by name — the ordering people
    // expect from a file tree.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
}

fn looks_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8192)];
    probe.contains(&0)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileContent, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let size = meta.len();

    if size > MAX_TEXT_BYTES {
        return Ok(FileContent { path, content: String::new(), size, binary: false, truncated: true });
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Ok(FileContent { path, content: String::new(), size, binary: true, truncated: false });
    }
    Ok(FileContent {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        path,
        size,
        binary: false,
        truncated: false,
    })
}

/// Fuzzy-ish file finder: substring match on the relative path, ranked so that
/// filename hits beat directory hits. Bounded so a monorepo cannot hang the UI.
/// Hidden and gitignored files follow the same settings as the tree.
#[tauri::command]
pub fn find_files(
    root: String,
    query: String,
    limit: Option<usize>,
    show_hidden: bool,
    respect_gitignore: bool,
) -> Result<Vec<DirEntryInfo>, String> {
    const MAX_DEPTH: usize = 12;
    let root_path = PathBuf::from(&root);
    let needle = query.trim().to_lowercase();
    let limit = limit.unwrap_or(200).min(1000);
    let rank = |name: &str, rel: &str| {
        if needle.is_empty() {
            Some(2)
        } else if name.to_lowercase().contains(&needle) {
            Some(0)
        } else if rel.to_lowercase().contains(&needle) {
            Some(1)
        } else {
            None
        }
    };

    let mut hits: Vec<(u8, DirEntryInfo)> = Vec::new();
    // Folders whose gitignored dot files are gathered once the walk is done.
    let mut dirs: Vec<PathBuf> = Vec::new();
    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .ignore(respect_gitignore)
        .parents(respect_gitignore)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH))
        .filter_entry(|e| e.file_name().to_str() != Some(".git"))
        .build();

    for entry in walker.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            if show_hidden && respect_gitignore && entry.depth() < MAX_DEPTH {
                dirs.push(entry.into_path());
            }
            continue;
        }
        let path = entry.path();
        let rel = to_rel(&root_path, path);
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rank) = rank(&name, &rel) else { continue };

        hits.push((
            rank,
            DirEntryInfo {
                size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                is_symlink: entry.path_is_symlink(),
                rel,
                name,
            },
        ));
        if hits.len() >= limit * 8 {
            break;
        }
    }

    // A file the walk saw but did not match fails `rank` here too, so only
    // the hits need excluding.
    let listed: HashSet<PathBuf> = hits.iter().map(|(_, e)| PathBuf::from(&e.path)).collect();
    for dir in &dirs {
        for e in ignored_dot_entries(&root_path, dir, &listed, false) {
            if let Some(rank) = rank(&e.name, &e.rel) {
                hits.push((rank, e));
            }
        }
    }

    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.rel.len().cmp(&b.1.rel.len())));
    Ok(hits.into_iter().take(limit).map(|(_, e)| e).collect())
}

#[tauri::command]
pub fn dir_name(path: String) -> String {
    Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path)
}

/// Writes the project's harness instructions next to the project so that any
/// agent — including ones AlmaStudio does not know about — can pick them up.
#[tauri::command]
pub fn write_project_instructions(root: String, contents: String) -> Result<String, String> {
    let dir = PathBuf::from(&root).join(".almastudio");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Make the folder ignore itself rather than editing the project's own
    // .gitignore. Dropping a file into someone's repo should not show up as a
    // change they have to explain in review.
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = fs::write(&ignore, "# Written by AlmaStudio; not part of the project.\n*\n");
    }

    let path = dir.join("instructions.md");
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- mutation --

/// Guards every write against a path that is not a normal, absolute location.
/// The frontend builds these paths from user input, so they are checked here
/// rather than trusted.
fn checked(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path must not contain ..".into());
    }
    Ok(p)
}

/// Whether a file or folder exists, for callers that must not act on a stale path.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    checked(&path).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<String, String> {
    let p = checked(&path)?;
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<String, String> {
    let p = checked(&path)?;
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, b"").map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<String, String> {
    let src = checked(&from)?;
    let dst = checked(&to)?;
    if !src.exists() {
        return Err(format!("{} does not exist", src.display()));
    }
    // Refuse to clobber. On case-insensitive filesystems a pure case change
    // maps to the same path, which is a legitimate rename and must be allowed.
    if dst.exists() && src.to_string_lossy().to_lowercase() != dst.to_string_lossy().to_lowercase()
    {
        return Err(format!("{} already exists", dst.display()));
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// Moves to the OS trash. Recovering a mistake should not need a backup.
#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    let p = checked(&path)?;
    if !p.exists() {
        return Err(format!("{} does not exist", p.display()));
    }
    trash::delete(&p).map_err(|e| format!("could not move to trash: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let p = checked(&path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Same write-then-rename dance the app uses for its own state: an editor
    // that truncates a file and then fails mid-write destroys the original.
    // Each save gets its own temporary file: two overlapping editor saves must
    // not overwrite one another's staged contents.
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = p.with_file_name(format!(
        ".{name}.almastudio-tmp-{}-{}",
        std::process::id(),
        WRITE_TEMP_SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    {
        use std::io::Write as _;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    // Preserve the original's permissions, which File::create would not.
    if let Ok(meta) = fs::metadata(&p) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Reads a small binary file as base64, used for project icons chosen from disk.
#[tauri::command]
pub fn read_file_base64(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    use base64::Engine as _;
    let p = checked(&path)?;
    let limit = max_bytes.unwrap_or(8 * 1024 * 1024);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > limit {
        return Err(format!("file is larger than {limit} bytes"));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Lets the file viewer load `path` through the asset protocol — and, for an
/// HTML preview, everything under `root`, so its stylesheets and images
/// resolve.
///
/// The scope starts empty and grows only with what the user opens. The
/// protocol is registered in every webview, browser tabs included; CORS keeps
/// a remote page from reading files through it, but a page could still tell
/// whether an allowed file exists by loading it as an image, so allowing the
/// whole disk up front would hand every site a way to probe it.
#[tauri::command]
pub fn allow_preview(app: tauri::AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    use tauri::Manager as _;
    let scope = app.asset_protocol_scope();
    scope.allow_file(checked(&path)?).map_err(|e| e.to_string())?;
    if let Some(root) = root {
        scope.allow_directory(checked(&root)?, true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git repository (as far as `ignore` is concerned) with a gitignored
    /// `.env`, a gitignored `dist`, a tracked `.gitignore` and a plain file.
    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), ".env\ndist/\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::create_dir(root.join("dist")).unwrap();
        fs::write(root.join("dist/app.js"), "").unwrap();
        fs::write(root.join("main.rs"), "").unwrap();
        dir
    }

    fn names(entries: Vec<DirEntryInfo>) -> Vec<String> {
        entries.into_iter().map(|e| e.name).collect()
    }

    fn list(root: &Path, show_hidden: bool, respect_gitignore: bool) -> Vec<String> {
        let root = root.to_string_lossy().to_string();
        names(list_dir(root, String::new(), show_hidden, respect_gitignore).unwrap())
    }

    #[test]
    fn shows_gitignored_dot_files_but_not_git() {
        let dir = project();
        assert_eq!(list(dir.path(), true, true), [".env", ".gitignore", "main.rs"]);
        assert_eq!(list(dir.path(), true, false), ["dist", ".env", ".gitignore", "main.rs"]);
        assert_eq!(list(dir.path(), false, true), ["main.rs"]);
    }

    #[test]
    fn finds_gitignored_dot_files_when_hidden_files_are_shown() {
        let dir = project();
        let root = dir.path().to_string_lossy().to_string();
        let find = |q: &str, show_hidden| {
            names(find_files(root.clone(), q.into(), None, show_hidden, true).unwrap())
        };
        assert_eq!(find("env", true), [".env"]);
        assert!(find("env", false).is_empty());
        assert!(find("app", true).is_empty());
        let mut all = find("", true);
        all.sort();
        assert_eq!(all, [".env", ".gitignore", "main.rs"]);
    }
}
