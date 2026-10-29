//! Keyboard focus for the main window on Windows.
//!
//! The main webview is a child view (see `fit_main_webview`), and Windows
//! hands the focus to the window itself when it is activated — back with
//! Alt-Tab, or from the taskbar. Nothing passed it on to the webview, so typing
//! went nowhere until the page was clicked. No focus event reaches the app
//! either: Tauri takes a window's focus from its webview's, which never got it.
//! wry passes the focus on only for a webview that fills its window on its own,
//! by subclassing the window, so this does the same for the main one.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager};

type Hwnd = *mut c_void;
type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;

#[link(name = "user32")]
extern "system" {
    fn GetFocus() -> Hwnd;
}

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(hwnd: Hwnd, proc_: SubclassProc, id: usize, data: usize) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
}

const WM_SETFOCUS: u32 = 0x0007;
/// Any number of our own: it tells this subclass from the window's others.
const SUBCLASS_ID: usize = 0x414c_4d41;

/// How long after the window takes the focus it is passed on. A click that
/// activated the window has given the focus to the webview it landed on by
/// then — a browser tab, say — and that one keeps it.
const SETTLE: Duration = Duration::from_millis(50);

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Starts passing the main window's focus on to its webview. Called once, on
/// the thread that owns the window.
pub fn follow(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let _ = APP.set(app.clone());
    unsafe { SetWindowSubclass(hwnd.0, on_message, SUBCLASS_ID, 0) };
}

unsafe extern "system" fn on_message(
    hwnd: Hwnd,
    msg: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    if msg == WM_SETFOCUS {
        pass_on_later(hwnd as usize);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn pass_on_later(hwnd: usize) {
    let Some(app) = APP.get().cloned() else { return };
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Only a focus still on the bare window. GetFocus answers for the
            // calling thread, which is the one that owns the window.
            if unsafe { GetFocus() } as usize != hwnd {
                return;
            }
            if let Some(webview) = handle.get_webview("main") {
                let _ = webview.set_focus();
            }
        });
    });
}
