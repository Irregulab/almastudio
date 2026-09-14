//! Text search across a folder, for the right panel's Search view.
//!
//! Walks the folder the way the file finder does — honouring .gitignore and
//! .ignore, never entering `.git` — reads each text file and reports the lines
//! that match. Starting a search cancels the one before it, so typing a query
//! never queues up walks of the whole tree.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::{WalkBuilder, WalkState};
use parking_lot::Mutex;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// The most recent search. Any other still walking stops at its next entry.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// Bigger files are almost always generated or data; reading them would stall
/// the search for hits nobody wants.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A line is shown from this many characters before its first match…
const PREVIEW_LEAD: usize = 40;
/// …and this many characters long at most.
const PREVIEW_CHARS: usize = 250;
const DEFAULT_MAX_MATCHES: usize = 2000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root: String,
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// Comma-separated globs, as in VS Code's "files to include".
    #[serde(default)]
    pub include: String,
    /// Comma-separated globs, as in VS Code's "files to exclude".
    #[serde(default)]
    pub exclude: String,
    pub max_matches: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u32,
    /// Where the line's first match starts, and its length, in UTF-16 code
    /// units: JavaScript string offsets, which is what the editor takes.
    pub column: u32,
    pub length: u32,
    /// The line, or the part of a long one around its first match.
    pub preview: String,
    /// Every match within `preview`, as UTF-16 `[start, end)` offsets.
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    /// Relative to the searched folder, with forward slashes.
    pub rel: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileMatches>,
    pub match_count: usize,
    /// The match limit was reached, so there may be more.
    pub truncated: bool,
    /// A newer search replaced this one before it finished.
    pub cancelled: bool,
}

type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;

#[tauri::command]
pub async fn search_text(query: SearchQuery) -> Result<SearchResults, String> {
    let generation = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    let is_current: IsCurrent = Arc::new(move || LATEST.load(Ordering::Relaxed) == generation);
    tauri::async_runtime::spawn_blocking(move || search(&query, is_current))
        .await
        .map_err(|e| e.to_string())?
}

/// The pattern, compiled twice: per line for the matches, and over a whole
/// file as a quick test of whether it is worth reading line by line.
struct Matcher {
    line: Regex,
    file: Regex,
}

fn build_matcher(query: &SearchQuery) -> Result<Matcher, String> {
    let source = if query.regex { query.pattern.clone() } else { regex::escape(&query.pattern) };
    let source = if query.whole_word { format!(r"\b(?:{source})\b") } else { source };
    let build = |whole_file: bool| {
        RegexBuilder::new(&source)
            .case_insensitive(!query.case_sensitive)
            // Over a whole file, `^` and `$` have to mean the start and end of
            // each line, as they do when a single line is matched.
            .multi_line(whole_file)
            .crlf(whole_file)
            .build()
            .map_err(|e| e.to_string())
    };
    Ok(Matcher { line: build(false)?, file: build(true)? })
}

/// A list of globs as VS Code takes them: separated by commas, and a bare name
/// standing for a file or folder of that name anywhere, with all it contains.
fn build_globs(list: &str) -> Result<GlobSet, String> {
    let mut set = GlobSetBuilder::new();
    for raw in list.split(',') {
        let glob = raw.trim().trim_start_matches("./").trim_end_matches('/');
        if glob.is_empty() {
            continue;
        }
        let base = if glob.contains('/') || glob.starts_with("**") {
            glob.to_string()
        } else {
            format!("**/{glob}")
        };
        for pattern in [base.clone(), format!("{base}/**")] {
            let compiled = GlobBuilder::new(&pattern)
                .literal_separator(true)
                .build()
                .map_err(|e| e.to_string())?;
            set.add(compiled);
        }
    }
    set.build().map_err(|e| e.to_string())
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn search(query: &SearchQuery, is_current: IsCurrent) -> Result<SearchResults, String> {
    if query.pattern.is_empty() {
        return Ok(SearchResults::default());
    }
    let matcher = Arc::new(build_matcher(query)?);
    let include = Arc::new(build_globs(&query.include)?);
    let exclude = Arc::new(build_globs(&query.exclude)?);
    let root = PathBuf::from(&query.root);
    let max = query.max_matches.unwrap_or(DEFAULT_MAX_MATCHES).clamp(1, 20_000);

    let files = Arc::new(Mutex::new(Vec::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    let filter_root = root.clone();
    let filter_exclude = exclude.clone();
    WalkBuilder::new(&root)
        // Dotfiles such as .env are searched; ignore files still apply.
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // A .gitignore counts in a folder that is not a repository yet, too.
        .require_git(false)
        .follow_links(false)
        // Excluded folders are pruned here rather than walked and discarded.
        .filter_entry(move |entry| {
            entry.file_name() != ".git"
                && (filter_exclude.is_empty()
                    || !filter_exclude.is_match(rel_path(&filter_root, entry.path())))
        })
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            let include = include.clone();
            let root = root.clone();
            let files = files.clone();
            let count = count.clone();
            let truncated = truncated.clone();
            let is_current = is_current.clone();
            Box::new(move |entry| {
                if !is_current() {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let rel = rel_path(&root, entry.path());
                if !include.is_empty() && !include.is_match(&rel) {
                    return WalkState::Continue;
                }
                let remaining = max.saturating_sub(count.load(Ordering::Relaxed));
                if remaining == 0 {
                    truncated.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                let Some(matches) = search_file(entry.path(), &matcher, remaining) else {
                    return WalkState::Continue;
                };
                let total = count.fetch_add(matches.len(), Ordering::Relaxed) + matches.len();
                files.lock().push(FileMatches {
                    path: entry.path().to_string_lossy().into_owned(),
                    rel,
                    matches,
                });
                if total >= max {
                    truncated.store(true, Ordering::Relaxed);
                    WalkState::Quit
                } else {
                    WalkState::Continue
                }
            })
        });

    let cancelled = !is_current();
    let mut files = std::mem::take(&mut *files.lock());
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    // Walker threads can each spend the last of the budget; trim back to it.
    let mut left = max;
    files.retain_mut(|file| {
        if left == 0 {
            return false;
        }
        file.matches.truncate(left);
        left -= file.matches.len();
        true
    });
    let match_count = files.iter().map(|f| f.matches.len()).sum();
    Ok(SearchResults {
        files,
        match_count,
        truncated: truncated.load(Ordering::Relaxed),
        cancelled,
    })
}

/// The matching lines of one file, at most `budget` of them. None for a file
/// that is too big, binary, unreadable or without a match.
fn search_file(path: &Path, matcher: &Matcher, budget: usize) -> Option<Vec<LineMatch>> {
    if path.metadata().ok()?.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // A NUL near the start is how git and ripgrep tell a binary file, too.
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    if !matcher.file.is_match(&text) {
        return None;
    }
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let spans: Vec<(usize, usize)> = matcher
            .line
            .find_iter(line)
            .map(|m| (m.start(), m.end()))
            .filter(|(start, end)| start < end)
            .collect();
        if spans.is_empty() {
            continue;
        }
        out.push(line_match(index + 1, line, &spans));
        if out.len() >= budget {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// One result row: the line's number, where its first match is, and a preview
/// cut to fit, starting a little before that match.
fn line_match(line_no: usize, line: &str, spans: &[(usize, usize)]) -> LineMatch {
    let utf16 = |from: usize, to: usize| line[from..to].encode_utf16().count() as u32;
    let first = spans[0].0;
    let indent = line.len() - line.trim_start().len();
    let lead = line[..first]
        .char_indices()
        .rev()
        .nth(PREVIEW_LEAD - 1)
        .map_or(0, |(i, _)| i);
    // Close enough to the start, the preview begins at the indentation.
    let start = if lead <= indent { indent.min(first) } else { lead };
    let end = line[start..]
        .char_indices()
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(i, _)| start + i);

    let prefix = if start > indent { "…" } else { "" };
    let suffix = if end < line.len() { "…" } else { "" };
    let offset = prefix.encode_utf16().count() as u32;
    let ranges = spans
        .iter()
        .filter(|(s, _)| *s < end)
        .map(|&(s, e)| [offset + utf16(start, s), offset + utf16(start, e.min(end))])
        .collect();

    LineMatch {
        line: line_no as u32,
        column: utf16(0, first),
        length: utf16(first, spans[0].1),
        preview: format!("{prefix}{}{suffix}", &line[start..end]),
        ranges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn query(root: &Path, pattern: &str) -> SearchQuery {
        SearchQuery {
            root: root.to_string_lossy().into_owned(),
            pattern: pattern.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: String::new(),
            exclude: String::new(),
            max_matches: None,
        }
    }

    fn run(q: &SearchQuery) -> SearchResults {
        search(q, Arc::new(|| true)).unwrap()
    }

    /// "rel:line,line" for every file found, in result order.
    fn found(results: &SearchResults) -> Vec<String> {
        results
            .files
            .iter()
            .map(|f| {
                let lines: Vec<String> = f.matches.iter().map(|m| m.line.to_string()).collect();
                format!("{}:{}", f.rel, lines.join(","))
            })
            .collect()
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, body) in [
            (".gitignore", &b"build/\n"[..]),
            ("src/app.ts", b"const greeting = 'Hello';\n// hello again\n"),
            ("src/notes.md", b"nothing here\r\nsay hello\r\n"),
            ("build/app.js", b"hello from a build\n"),
            (".git/config", b"hello from git\n"),
            ("node_modules/lib/index.js", b"hello from a dependency\n"),
            ("logo.bin", b"\x00\x01hello"),
            (".env", b"GREETING=hello\n"),
        ] {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        dir
    }

    #[test]
    fn finds_lines_skipping_ignored_git_and_binary_files() {
        let dir = tree();
        let results = run(&query(dir.path(), "hello"));
        assert_eq!(
            found(&results),
            [".env:1", "node_modules/lib/index.js:1", "src/app.ts:1,2", "src/notes.md:2"],
        );
        assert_eq!(results.match_count, 5);
        assert!(!results.truncated && !results.cancelled);
    }

    #[test]
    fn honours_case_and_whole_words() {
        let dir = tree();
        let mut q = query(dir.path(), "Hello");
        q.case_sensitive = true;
        assert_eq!(found(&run(&q)), ["src/app.ts:1"]);

        let mut q = query(dir.path(), "hell");
        q.whole_word = true;
        assert!(run(&q).files.is_empty());
    }

    #[test]
    fn takes_the_pattern_literally_unless_it_is_a_regex() {
        let dir = tree();
        let mut q = query(dir.path(), "hello.*again");
        assert!(run(&q).files.is_empty());
        q.regex = true;
        assert_eq!(found(&run(&q)), ["src/app.ts:2"]);

        q.pattern = "(".into();
        assert!(search(&q, Arc::new(|| true)).is_err());
    }

    #[test]
    fn anchors_apply_to_each_line_including_crlf_ones() {
        let dir = tree();
        let mut q = query(dir.path(), "^say hello$");
        q.regex = true;
        assert_eq!(found(&run(&q)), ["src/notes.md:2"]);
    }

    #[test]
    fn filters_by_include_and_exclude_globs() {
        let dir = tree();
        let mut q = query(dir.path(), "hello");
        q.include = "src".into();
        assert_eq!(found(&run(&q)), ["src/app.ts:1,2", "src/notes.md:2"]);

        q.include = "*.md".into();
        assert_eq!(found(&run(&q)), ["src/notes.md:2"]);

        q.include = String::new();
        q.exclude = "node_modules, .env".into();
        assert_eq!(found(&run(&q)), ["src/app.ts:1,2", "src/notes.md:2"]);
    }

    #[test]
    fn stops_at_the_match_limit() {
        let dir = tree();
        let mut q = query(dir.path(), "hello");
        q.max_matches = Some(2);
        let results = run(&q);
        assert_eq!(results.match_count, 2);
        assert!(results.truncated);
    }

    #[test]
    fn a_superseded_search_reports_itself_cancelled() {
        let dir = tree();
        let results = search(&query(dir.path(), "hello"), Arc::new(|| false)).unwrap();
        assert!(results.cancelled);
        assert!(results.files.is_empty());
    }

    fn spans_of(line: &str, needle: &str) -> Vec<(usize, usize)> {
        line.match_indices(needle).map(|(i, m)| (i, i + m.len())).collect()
    }

    #[test]
    fn preview_starts_at_the_indentation_of_a_short_line() {
        let line = "    let x = foo(); foo";
        let m = line_match(3, line, &spans_of(line, "foo"));
        assert_eq!(m.preview, "let x = foo(); foo");
        assert_eq!(m.ranges, [[8, 11], [15, 18]]);
        assert_eq!((m.line, m.column, m.length), (3, 12, 3));
    }

    #[test]
    fn preview_of_a_long_line_is_cut_around_its_first_match() {
        let line = format!("{}needle{}", "a".repeat(100), "b".repeat(300));
        let m = line_match(1, &line, &spans_of(&line, "needle"));
        assert!(m.preview.starts_with(&format!("…{}needle", "a".repeat(40))));
        assert!(m.preview.ends_with("b…"));
        assert_eq!(m.preview.chars().count(), 1 + 250 + 1);
        assert_eq!(m.ranges, [[41, 47]]);
        assert_eq!(m.column, 100);
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let line = "😀 è needle";
        let m = line_match(1, line, &spans_of(line, "needle"));
        assert_eq!(m.column, 5);
        assert_eq!(m.ranges, [[5, 11]]);
    }

    #[test]
    fn globs_follow_vscode_conventions() {
        let set = build_globs("src, *.md, docs/api/").unwrap();
        for hit in ["src/a.ts", "lib/src/b.ts", "readme.md", "a/b/c.md", "docs/api/x.json"] {
            assert!(set.is_match(hit), "{hit} should match");
        }
        for miss in ["docs/other/x.json", "srcs/a.ts", "lib/a.ts"] {
            assert!(!set.is_match(miss), "{miss} should not match");
        }
    }
}
