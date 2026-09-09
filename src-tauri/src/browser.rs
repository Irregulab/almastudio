//! Browser tabs.
//!
//! A browser tab is a real child webview layered over the pane that owns it,
//! not an iframe: most sites refuse to be framed, and an iframe would also be
//! subject to this app's own CSP. The trade-off is that a native webview is
//! not part of the HTML stacking order — it floats above everything — so the
//! frontend hides it whenever a modal or menu is open, and whenever its tab is
//! not the visible one.

use serde::{Deserialize, Serialize};
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
    WebviewUrl,
};

/// Child webviews are named after their tab so the frontend can address them.
fn label_for(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("browser-{cleaned}")
}

fn parse_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty url".into());
    }
    // Bare hosts and search terms are common input; only obvious URLs are
    // treated as such, the rest is handed to a search engine.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || (trimmed.contains('.') && !trimmed.contains(' '))
    {
        format!("http://{trimmed}")
    } else {
        format!(
            "https://duckduckgo.com/?q={}",
            urlencoding_lite(trimmed)
        )
    };
    url::Url::parse(&candidate).map_err(|e| format!("invalid url: {e}"))
}

/// Minimal percent-encoding for a query string; pulling in a crate for this
/// would be more dependency than it is worth.
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigatedPayload {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub url: String,
    pub exists: bool,
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    bounds: Bounds,
) -> Result<String, String> {
    let label = label_for(&id);
    let target = parse_url(&url)?;

    if let Some(existing) = app.get_webview(&label) {
        existing.navigate(target.clone()).map_err(|e| e.to_string())?;
        return Ok(target.to_string());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;

    // Report navigations rather than having the frontend poll for them: links,
    // redirects and history moves all come through here.
    let notify = app.clone();
    let nav_id = id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
        // A browser tab must not inherit the app's own IPC surface.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let _ = notify.emit(
                "browser://navigated",
                NavigatedPayload { id: nav_id.clone(), url: url.to_string() },
            );
            true
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| format!("could not create browser view: {e}"))?;

    Ok(target.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let Some(view) = app.get_webview(&label_for(&id)) else { return Ok(()) };
    view.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let Some(view) = app.get_webview(&label_for(&id)) else { return Ok(()) };
    if visible {
        view.show().map_err(|e| e.to_string())
    } else {
        view.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<String, String> {
    let view = app
        .get_webview(&label_for(&id))
        .ok_or_else(|| "browser view is not open".to_string())?;
    let target = parse_url(&url)?;
    view.navigate(target.clone()).map_err(|e| e.to_string())?;
    Ok(target.to_string())
}

/// back / forward / reload are driven through the page's own history API;
/// wry exposes no navigation controls of its own.
#[tauri::command]
pub fn browser_command(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let Some(view) = app.get_webview(&label_for(&id)) else { return Ok(()) };
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        other => return Err(format!("unknown action {other}")),
    };
    view.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_state(app: AppHandle, id: String) -> BrowserState {
    match app.get_webview(&label_for(&id)) {
        Some(view) => BrowserState {
            url: view.url().map(|u| u.to_string()).unwrap_or_default(),
            exists: true,
        },
        None => BrowserState { url: String::new(), exists: false },
    }
}

#[tauri::command]
pub fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label_for(&id)) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drops every browser view; used when the window closes so none are orphaned.
pub fn close_all(app: &AppHandle) {
    for (label, view) in app.webviews() {
        if label.starts_with("browser-") {
            let _ = view.close();
        }
    }
}
