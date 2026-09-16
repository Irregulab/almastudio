mod browser;
mod editors;
mod fsx;
mod git;
mod git_cli;
mod harness;
mod menu;
mod pty;
mod search;
mod store;
mod watcher;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

use pty::PtyManager;
use watcher::WatchManager;

/// Gates shutdown behind the frontend's confirmation.
///
/// Quitting kills every running agent, so it asks first. The frontend decides
/// whether to prompt — it knows what is running and whether the user turned
/// the prompt off — and calls `confirm_exit` when it is done. Two close
/// attempts in quick succession bypass all of it, so a wedged or broken
/// frontend can never trap the user in an app they cannot quit.
#[derive(Default)]
struct ExitGate {
    confirmed: AtomicBool,
    last_request: Mutex<Option<Instant>>,
}

/// A second attempt within this window force-quits.
const FORCE_QUIT_WINDOW: Duration = Duration::from_secs(3);

impl ExitGate {
    /// True when shutdown should proceed; false when the frontend was asked.
    fn should_proceed(&self, app: &tauri::AppHandle) -> bool {
        if self.confirmed.load(Ordering::Relaxed) {
            return true;
        }
        let mut last = self.last_request.lock();
        if let Some(at) = *last {
            if at.elapsed() < FORCE_QUIT_WINDOW {
                self.confirmed.store(true, Ordering::Relaxed);
                return true;
            }
        }
        *last = Some(Instant::now());
        drop(last);
        let _ = app.emit("app://close-requested", ());
        false
    }
}

#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    app.state::<ExitGate>().confirmed.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Lets the frontend drop a pending request when the user cancels, so the
/// force-quit window does not linger and turn an unrelated later close into an
/// immediate quit.
#[tauri::command]
fn cancel_exit(app: tauri::AppHandle) {
    *app.state::<ExitGate>().last_request.lock() = None;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    pub debug: bool,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        name: app.package_info().name.clone(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug: cfg!(debug_assertions),
    }
}

/// The webview is created hidden so the user never sees an unstyled flash; the
/// frontend calls this once it has painted with the right theme.
#[tauri::command]
fn ready(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
    // Only once shown is the window on its real display, with the restored
    // size in place — the plugin applies it asynchronously — and already
    // narrowed by macOS if it was wider than the screen.
    fit_to_screen(&window);
    fit_main_webview(&window);
}

/// Sizes the main webview to fill its window as it is right now.
///
/// With the `unstable` feature (needed for browser tabs) the main webview is a
/// child view. Tauri keeps such a view at a fixed fraction of its window, and
/// recomputes that fraction whenever it is given an explicit size — dividing
/// by the window's size at that later moment. A size read a moment too early
/// (the restored size before macOS narrowed a window wider than the screen,
/// the old size across a scale change) made the fraction wrong for good: the
/// page stayed wider than the window, cut off on the right, through every
/// later resize. So Tauri's resizing is off for this webview (see `setup`) and
/// this runs on every resize, scale change and focus, reading the size afresh.
fn fit_main_webview<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Some(webview) = window.app_handle().get_webview("main") else { return };
    // On macOS the overlay title bar puts the content under it, so the frame
    // is the content area — and the frame is what macOS itself constrains.
    let size = if cfg!(target_os = "macos") {
        window.outer_size()
    } else {
        window.inner_size()
    };
    if let Ok(size) = size {
        let _ = webview.set_size(size);
    }
}

/// Surfaces uncaught frontend errors on stderr, where `tauri dev` shows them,
/// and appends them to a log file in the app's data directory. A shipped
/// build's stderr goes nowhere the user can read, so without the file a crash
/// there leaves no trace at all beyond "the window went blank".
#[tauri::command]
fn log_frontend(app: tauri::AppHandle, level: String, message: String) {
    eprintln!("almastudio[web/{level}] {message}");
    use std::io::Write as _;

    let Ok(dir) = app.path().app_data_dir() else { return };
    let logs = dir.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{epoch}] [{level}] {message}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("frontend.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Default shell for the platform, shown in Settings as the placeholder.
#[tauri::command]
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Keeps the restored geometry usable on whatever screen is actually here.
///
/// The window-state plugin restores the saved size unconditionally and only
/// sanity-checks the position, so a window last used on a large external
/// display comes back taller than a laptop screen with its title bar off the
/// top — unmovable and unresizable. This clamps the window to the current
/// monitor's work area.
///
/// It runs once the window is shown. The plugin applies the restored size
/// asynchronously, so from `setup` this still saw the configured size — and
/// resizing to that, clamped, went on to replace the restored one.
fn fit_to_screen<R: tauri::Runtime>(window: &tauri::Window<R>) {
    // A maximized or fullscreen window already fills the screen exactly;
    // clamping it would shave the margin off and break out of that state.
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) else {
        return;
    };
    let area = monitor.work_area();
    let Ok(size) = window.outer_size() else { return };
    let Ok(position) = window.outer_position() else { return };

    // Leave a margin so the window never sits flush against the screen edge.
    const MARGIN: i32 = 8;
    let max_w = area.size.width.saturating_sub(MARGIN as u32 * 2);
    let max_h = area.size.height.saturating_sub(MARGIN as u32 * 2);

    let width = size.width.min(max_w).max(600);
    let height = size.height.min(max_h).max(400);
    if width != size.width || height != size.height {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }

    // The title bar has to stay reachable, so the window may not start above
    // the work area or be pushed entirely off either side.
    let min_x = area.position.x + MARGIN;
    let max_x = area.position.x + area.size.width as i32 - width as i32 - MARGIN;
    let min_y = area.position.y + MARGIN;
    let max_y = area.position.y + area.size.height as i32 - height as i32 - MARGIN;

    let x = position.x.clamp(min_x.min(max_x), max_x.max(min_x));
    let y = position.y.clamp(min_y.min(max_y), max_y.max(min_y));
    if x != position.x || y != position.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// Which parts of the window state are persisted. Kept in one place because
/// the periodic save below has to use the same set as the plugin itself.
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

/// Records that the window moved or resized; the flusher below writes it out.
#[derive(Default)]
struct GeometryDirty(Mutex<Option<Instant>>);

/// Persists window geometry shortly after it settles.
///
/// The plugin only saves on a graceful close, so a crash, a force-quit or a
/// power cut loses the window's position — the same failure the workspace and
/// settings already guard against by writing on a debounce rather than at
/// exit. This applies that policy to the geometry too.
///
/// The save itself must run on the main thread. `save_window_state` holds the
/// plugin's cache lock while it queries the window, and from any other thread
/// each query is a round trip through the main thread's event loop. The
/// plugin's own `Moved`/`Resized` handler takes that same lock on the main
/// thread, so a move landing mid-save — which is what the display
/// reconfiguration after waking from sleep produces — deadlocked the two and
/// froze the whole app.
fn spawn_geometry_flusher(app: tauri::AppHandle) {
    const SETTLE: Duration = Duration::from_millis(700);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let Some(dirty) = app.try_state::<GeometryDirty>() else { break };
        let due = {
            let mut at = dirty.0.lock();
            match *at {
                // Wait for dragging to stop before writing, so one resize does
                // not produce a hundred writes.
                Some(t) if t.elapsed() >= SETTLE => {
                    *at = None;
                    true
                }
                _ => false,
            }
        };
        if due {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = handle.save_window_state(WINDOW_STATE_FLAGS);
            });
        }
    });
}

/// True when the plugin has geometry saved for this window from a previous run.
fn has_saved_geometry(app: &tauri::AppHandle) -> bool {
    app.path()
        .app_config_dir()
        .map(|d| d.join(".window-state.json").exists())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // VISIBLE is deliberately excluded: restoring it would show
                // the window before the frontend has painted, undoing the
                // hidden start that avoids an unstyled flash.
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(PtyManager::default())
        .manage(WatchManager::default())
        .manage(ExitGate::default())
        .manage(GeometryDirty::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            ready,
            default_shell,
            log_frontend,
            confirm_exit,
            cancel_exit,
            menu::apply_menu,
            harness::installed_harnesses,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_status,
            store::state_load,
            store::state_save,
            store::state_dir_path,
            store::scrollback_load,
            store::scrollback_prune,
            store::scrollback_forget,
            git::git_status,
            git::git_diff_file,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_graph,
            git::git_branches,
            git::git_stashes,
            git::git_tags,
            git::git_commit_details,
            git::git_compare_commits,
            git_cli::git_fetch,
            git_cli::git_pull,
            git_cli::git_push,
            git_cli::git_sync,
            git_cli::git_push_tags,
            git_cli::git_commit,
            git_cli::git_undo_commit,
            git_cli::git_checkout,
            git_cli::git_create_branch,
            git_cli::git_rename_branch,
            git_cli::git_delete_branch,
            git_cli::git_delete_remote_branch,
            git_cli::git_merge,
            git_cli::git_rebase,
            git_cli::git_cherry_pick,
            git_cli::git_revert,
            git_cli::git_reset,
            git_cli::git_push_tag,
            git_cli::git_continue,
            git_cli::git_abort,
            git_cli::git_stash,
            git_cli::git_stash_apply,
            git_cli::git_stash_pop,
            git_cli::git_stash_drop,
            git_cli::git_create_tag,
            git_cli::git_delete_tag,
            git_cli::git_apply_hunk,
            git_cli::git_mark_resolved,
            git::find_git_repos,
            fsx::list_dir,
            fsx::read_text_file,
            fsx::find_files,
            fsx::dir_name,
            fsx::write_project_instructions,
            fsx::create_dir,
            fsx::create_file,
            fsx::rename_path,
            fsx::trash_path,
            fsx::write_text_file,
            fsx::read_file_base64,
            fsx::allow_preview,
            fsx::path_exists,
            search::search_text,
            editors::external_editors,
            editors::open_in_editor,
            watcher::watch_start,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_command,
            browser::browser_state,
            browser::browser_close,
            watcher::watch_stop,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = handle.get_webview_window("main") {
                if !has_saved_geometry(&handle) {
                    // First run: `center` was removed from the window config
                    // because it overrode the restored position, so centring
                    // happens here instead — only when there is nothing to
                    // restore.
                    let _ = window.set_size(LogicalSize::new(1440.0, 900.0));
                    let _ = window.center();
                }
            }
            // Sized by hand instead; see `fit_main_webview`.
            if let Some(webview) = handle.get_webview("main") {
                let _ = webview.set_auto_resize(false);
            }
            let all = menu::ALL_HARNESSES.map(String::from);
            menu::build(&handle, HashMap::new(), &all)?;
            store::spawn_scrollback_flusher(handle.clone());
            pty::spawn_activity_monitor(handle.clone());
            spawn_geometry_flusher(handle.clone());

            // The window starts hidden so the user never sees an unstyled
            // flash, and the frontend calls `ready` once it has painted. If it
            // never gets that far — a bad build, a thrown error — show the
            // window anyway rather than leaving a process with no UI.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        eprintln!(
                            "almastudio: frontend never called `ready`; \
                             revealing the window from the backstop"
                        );
                        let _ = w.show();
                        let _ = w.set_focus();
                        let window = w.as_ref().window();
                        fit_to_screen(&window);
                        fit_main_webview(&window);
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            // The main webview follows its window by hand; see
            // `fit_main_webview`. Focus is included so that a size which
            // changed without a resize reaching us is put right as soon as
            // the window is used again.
            if window.label() == "main"
                && matches!(
                    event,
                    WindowEvent::Resized(_)
                        | WindowEvent::ScaleFactorChanged { .. }
                        | WindowEvent::Focused(true)
                )
            {
                fit_main_webview(window);
            }
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                if let Some(dirty) = window.app_handle().try_state::<GeometryDirty>() {
                    *dirty.0.lock() = Some(Instant::now());
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // Save first either way: whether or not the user goes through
                // with quitting, the state on disk should be current.
                if let Some(mgr) = app.try_state::<PtyManager>() {
                    store::flush_scrollback(app, &mgr);
                }
                if !app.state::<ExitGate>().should_proceed(app) {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AlmaStudio")
        .run(|app, event| {
            // Quitting from the menu or the dock does not raise a window close,
            // so the same gate has to cover this path.
            if let RunEvent::ExitRequested { api, .. } = &event {
                if !app.state::<ExitGate>().should_proceed(app) {
                    api.prevent_exit();
                    return;
                }
            }
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // Never leave orphaned agent or shell processes
                // behind when the app goes away.
                if let Some(mgr) = app.try_state::<PtyManager>() {
                    store::flush_scrollback(app, &mgr);
                    mgr.kill_all();
                }
                browser::close_all(app);
                if let Some(w) = app.try_state::<WatchManager>() {
                    w.stop_all();
                }
            }
        });
}
