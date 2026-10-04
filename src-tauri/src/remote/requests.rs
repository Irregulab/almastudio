//! What a connected client may ask for.
//!
//! Requests are `{ t: "req", id, m, p }` and are answered with
//! `{ t: "res", id, ok, r | e }`. Terminal methods are served here, straight
//! from the pty manager. Methods that change the workspace go to the frontend
//! (see `RemoteHub::forward_to_frontend`).

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::pty::{emit_size_owner, PtyManager};
use crate::store::scrollback_of;

use super::RemoteHub;

// Only the read-only side of git, files and search is reachable from the app.

/// Methods the frontend answers, because it owns the tabs.
const FORWARDED: &[&str] = &["tab.open", "tab.close", "tab.start", "tab.restart", "tab.kill"];

pub fn handle(app: &AppHandle, client: u64, plain: Vec<u8>) {
    let Ok(msg) = serde_json::from_slice::<Value>(&plain) else { return };
    let hub = app.state::<RemoteHub>();
    match msg["t"].as_str() {
        Some("ping") => hub.send_to(client, json!({ "t": "pong" }).to_string()),
        Some("req") => {
            let id = msg["id"].clone();
            let method = msg["m"].as_str().unwrap_or_default().to_string();
            let params = msg["p"].clone();
            if FORWARDED.contains(&method.as_str()) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let hub = app.state::<RemoteHub>();
                    let result = hub.forward_to_frontend(&app, &method, params).await;
                    hub.send_to(client, response(id, result));
                });
            } else if is_blocking(&method) {
                // Git and file reads can take a while on a big repository;
                // keep them off the async workers.
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = dispatch(&app, client, &method, params);
                    app.state::<RemoteHub>().send_to(client, response(id, result));
                });
            } else {
                let result = dispatch(app, client, &method, params);
                hub.send_to(client, response(id, result));
            }
        }
        _ => {}
    }
}

fn response(id: Value, result: Result<Value, String>) -> String {
    match result {
        Ok(r) => json!({ "t": "res", "id": id, "ok": true, "r": r }),
        Err(e) => json!({ "t": "res", "id": id, "ok": false, "e": e }),
    }
    .to_string()
}

fn is_blocking(method: &str) -> bool {
    method.starts_with("git.") || method.starts_with("fs.") || method.starts_with("search.")
}

fn params<T: for<'de> Deserialize<'de>>(p: Value) -> Result<T, String> {
    serde_json::from_value(p).map_err(|e| format!("bad params: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabParams {
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputParams {
    tab_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeParams {
    tab_id: String,
    cols: u16,
    rows: u16,
}

fn dispatch(app: &AppHandle, client: u64, method: &str, p: Value) -> Result<Value, String> {
    let hub = app.state::<RemoteHub>();
    let mgr = app.state::<PtyManager>();
    match method {
        "desktop.info" => {
            let (name, port) = {
                let inner = hub.inner.lock();
                (inner.name.clone(), inner.server.as_ref().map(|s| s.port))
            };
            let addresses: Vec<String> = match port {
                Some(port) => super::lan_addresses().into_iter().map(|a| format!("{a}:{port}")).collect(),
                None => Vec::new(),
            };
            Ok(json!({
                "name": name,
                "version": app.package_info().version.to_string(),
                "os": std::env::consts::OS,
                "addresses": addresses,
                "relay": hub.inner.lock().relay_url.clone(),
            }))
        }
        "workspace.get" => {
            let workspace = hub.inner.lock().workspace.clone();
            Ok(json!({ "workspace": workspace, "busy": mgr.busy_ids() }))
        }
        "term.attach" => {
            let TabParams { tab_id } = params(p)?;
            // Subscribe before the snapshot: a batch emitted in between is in
            // the snapshot too, and the app drops what arrives before this
            // answer, so nothing is lost or shown twice.
            hub.set_attached(client, &tab_id, true);
            let snap = scrollback_of(app, &mgr, &tab_id)?;
            let (alive, exit_code) = mgr.status(&tab_id).unwrap_or((false, 0));
            let owner = mgr.size_owner(&tab_id);
            let (cols, rows) = mgr.desktop_size(&tab_id).unwrap_or((0, 0));
            Ok(json!({
                "desktopSize": { "cols": cols, "rows": rows },
                "b64": snap.b64,
                "end": snap.end,
                "live": snap.live,
                "alive": alive,
                "exitCode": exit_code,
                "owner": { "remote": owner.is_some(), "mine": owner == Some(client) },
            }))
        }
        "term.detach" => {
            let TabParams { tab_id } = params(p)?;
            hub.set_attached(client, &tab_id, false);
            if mgr.release_remote(&tab_id, client) {
                emit_size_owner(app, &tab_id, false);
            }
            Ok(Value::Null)
        }
        "term.input" => {
            let InputParams { tab_id, data } = params(p)?;
            mgr.write(&tab_id, data.as_bytes()).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "term.resize" => {
            let ResizeParams { tab_id, cols, rows } = params(p)?;
            let changed =
                mgr.resize_remote(&tab_id, client, cols, rows).map_err(|e| e.to_string())?;
            if changed {
                emit_size_owner(app, &tab_id, true);
            }
            Ok(Value::Null)
        }
        "term.release" => {
            let TabParams { tab_id } = params(p)?;
            if mgr.release_remote(&tab_id, client) {
                emit_size_owner(app, &tab_id, false);
            }
            Ok(Value::Null)
        }
        "push.register" => {
            #[derive(Deserialize)]
            struct Register {
                token: String,
                platform: String,
            }
            let Register { token, platform } = params(p)?;
            if !token.starts_with("ExponentPushToken[") && !token.starts_with("ExpoPushToken[") {
                return Err("not an Expo push token".into());
            }
            hub.register_push(app, client, Some(super::push::PushTarget { token, platform }))?;
            Ok(Value::Null)
        }
        "push.unregister" => {
            hub.register_push(app, client, None)?;
            Ok(Value::Null)
        }
        "git.repos" => {
            let ProjectParams { project_id, .. } = params(p)?;
            let root = resolve_root(&hub, &project_id, None)?;
            let repos = crate::git::find_git_repos(root, Some(3))?;
            to_value(repos)
        }
        "git.status" => {
            let ProjectParams { project_id, root } = params(p)?;
            to_value(crate::git::git_status(resolve_root(&hub, &project_id, root)?)?)
        }
        "git.diff" => {
            let d: DiffParams = params(p)?;
            let root = resolve_root(&hub, &d.project_id, Some(d.root))?;
            relative_inside(&d.path)?;
            if let Some(old) = &d.old_path {
                relative_inside(old)?;
            }
            let side: crate::git::DiffSide = serde_json::from_value(json!(d.side))
                .map_err(|_| "bad side".to_string())?;
            to_value(crate::git::git_diff_file(
                root, d.path, side, Some(3), d.old_path, d.base, d.target,
            )?)
        }
        "git.graph" => {
            let g: GraphParams = params(p)?;
            let root = resolve_root(&hub, &g.project_id, Some(g.root))?;
            to_value(crate::git::git_graph(root, Some(g.limit.unwrap_or(150).min(500)), None)?)
        }
        "git.commit" => {
            let c: CommitParams = params(p)?;
            let root = resolve_root(&hub, &c.project_id, Some(c.root))?;
            to_value(crate::git::git_commit_details(root, c.id)?)
        }
        "fs.list" => {
            let f: ListParams = params(p)?;
            let root = resolve_root(&hub, &f.project_id, f.root)?;
            // `list_dir` refuses a folder outside `root` itself.
            to_value(crate::fsx::list_dir(root, f.dir, true, true)?)
        }
        "fs.read" => {
            let f: ReadParams = params(p)?;
            let root = resolve_root(&hub, &f.project_id, f.root)?;
            to_value(crate::fsx::read_text_file(f.path, Some(root))?)
        }
        "search.text" => {
            let q: SearchParams = params(p)?;
            let root = resolve_root(&hub, &q.project_id, q.root)?;
            let query = crate::search::SearchQuery {
                root,
                pattern: q.pattern,
                case_sensitive: q.case_sensitive,
                whole_word: q.whole_word,
                regex: q.regex,
                include: String::new(),
                exclude: String::new(),
                max_matches: Some(500),
            };
            // Its own generation counter: a search from the app must not
            // cancel one running in the desktop's panel, nor the reverse.
            static REMOTE_SEARCH: AtomicU64 = AtomicU64::new(0);
            let generation = REMOTE_SEARCH.fetch_add(1, Ordering::SeqCst) + 1;
            let is_current: crate::search::IsCurrent =
                Arc::new(move || REMOTE_SEARCH.load(Ordering::Relaxed) == generation);
            to_value(crate::search::search(&query, is_current)?)
        }
        _ => Err(format!("unknown method {method}")),
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectParams {
    project_id: String,
    #[serde(default)]
    root: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    project_id: String,
    root: String,
    path: String,
    side: String,
    old_path: Option<String>,
    base: Option<String>,
    target: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphParams {
    project_id: String,
    root: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitParams {
    project_id: String,
    root: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    project_id: String,
    root: Option<String>,
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    project_id: String,
    root: Option<String>,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    project_id: String,
    root: Option<String>,
    pattern: String,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    regex: bool,
}

/// A repository-relative path that stays inside the repository.
fn relative_inside(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("path must be relative to the repository".into());
    }
    Ok(())
}

/// The folder a request may look at: the project's own, or one inside it, or
/// one of its pinned repositories or tab folders. The app names a project and
/// optionally a folder; it never gets to read outside what the desktop shows
/// for that project.
fn resolve_root(hub: &RemoteHub, project_id: &str, root: Option<String>) -> Result<String, String> {
    let (project_root, extras) = {
        let inner = hub.inner.lock();
        let project = inner
            .workspace
            .get("projects")
            .and_then(Value::as_array)
            .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(project_id)))
            .ok_or("no such project")?;
        let root = project["root"].as_str().unwrap_or_default().to_string();
        let mut extras: Vec<String> = project["pinnedRepos"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        extras.extend(
            project["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t["cwd"].as_str().map(String::from)),
        );
        (root, extras)
    };
    allowed_root(&project_root, &extras, root)
}

fn allowed_root(project_root: &str, extras: &[String], root: Option<String>) -> Result<String, String> {
    let Some(root) = root.filter(|r| !r.is_empty()) else {
        return Ok(project_root.to_string());
    };
    let canon = |p: &str| -> Option<PathBuf> {
        let path = Path::new(p);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        std::fs::canonicalize(path).ok()
    };
    let wanted = canon(&root).ok_or("no such folder")?;
    let allowed = std::iter::once(project_root)
        .chain(extras.iter().map(String::as_str))
        .filter_map(canon)
        .any(|base| wanted.starts_with(&base));
    if allowed {
        Ok(root)
    } else {
        Err("that folder is outside the project".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_stay_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        let inner = project.join("sub");
        let elsewhere = dir.path().join("other");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let p = project.to_string_lossy().to_string();
        let s = |x: &std::path::Path| x.to_string_lossy().to_string();

        assert_eq!(allowed_root(&p, &[], None).unwrap(), p);
        assert!(allowed_root(&p, &[], Some(s(&inner))).is_ok());
        assert!(allowed_root(&p, &[], Some(s(&elsewhere))).is_err());
        // A tab or a pinned repository elsewhere is allowed by name.
        assert!(allowed_root(&p, &[s(&elsewhere)], Some(s(&elsewhere))).is_ok());
        // No climbing out, and no escaping through a symlink.
        assert!(allowed_root(&p, &[], Some(format!("{p}/sub/../.."))).is_err());
        #[cfg(unix)]
        {
            let link = project.join("link");
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            assert!(allowed_root(&p, &[], Some(s(&link))).is_err());
        }
    }

    #[test]
    fn repository_paths_must_be_relative() {
        assert!(relative_inside("src/main.rs").is_ok());
        assert!(relative_inside("../secret").is_err());
        assert!(relative_inside("/etc/passwd").is_err());
        assert!(relative_inside("a/../../b").is_err());
    }
}
