mod browser;
mod fsx;
mod git;
mod menu;
mod pty;
mod store;
mod watcher;

use std::collections::HashMap;

use serde::Serialize;
use tauri::{Manager, RunEvent, WindowEvent};

use pty::PtyManager;
use watcher::WatchManager;

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
}

/// Surfaces uncaught frontend errors on stderr, where `tauri dev` shows them.
/// The webview's own console is otherwise invisible unless devtools are open,
/// which makes a boot-time exception look like a blank window.
#[tauri::command]
fn log_frontend(level: String, message: String) {
    eprintln!("almastudio[web/{level}] {message}");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(PtyManager::default())
        .manage(WatchManager::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            ready,
            default_shell,
            log_frontend,
            menu::apply_menu,
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
            git::git_commit,
            git::git_log,
            git::git_branches,
            git::git_checkout,
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
            menu::build(&handle, HashMap::new())?;
            store::spawn_scrollback_flusher(handle.clone());
            pty::spawn_activity_monitor(handle.clone());

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
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Persist what the tabs were showing before the processes die,
                // so a restart can restore them.
                let app = window.app_handle();
                if let Some(mgr) = app.try_state::<PtyManager>() {
                    store::flush_scrollback(app, &mgr);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AlmaStudio")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // Never leave orphaned `claude` / `codex` / shell processes
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
