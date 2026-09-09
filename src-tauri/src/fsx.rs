//! Filesystem access for the "all files" tree, the quick file finder and the
//! file viewer. Listing is lazy — one directory level per call — so opening a
//! monorepo costs the same as opening a toy project.

use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;

/// Above this a file is shown as "too large to display" rather than shipped
/// into the webview.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

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
#[tauri::command]
pub fn find_files(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<DirEntryInfo>, String> {
    let root_path = PathBuf::from(&root);
    let needle = query.trim().to_lowercase();
    let limit = limit.unwrap_or(200).min(1000);

    let mut hits: Vec<(u8, DirEntryInfo)> = Vec::new();
    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(12))
        .build();

    for entry in walker.flatten() {
        if entry.depth() == 0 || entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let path = entry.path();
        let rel = to_rel(&root_path, path);
        let name = entry.file_name().to_string_lossy().to_string();

        let rank = if needle.is_empty() {
            2
        } else if name.to_lowercase().contains(&needle) {
            0
        } else if rel.to_lowercase().contains(&needle) {
            1
        } else {
            continue;
        };

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
