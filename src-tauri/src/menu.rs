//! Native application menu.
//!
//! Labels are supplied by the frontend so the menu speaks the same language as
//! the rest of the UI; changing the language in Settings rebuilds it. Every
//! item simply emits `menu://<id>` and the frontend decides what to do, which
//! keeps all behaviour in one place.

use std::collections::HashMap;

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Fallback labels, used for the split second before the frontend has loaded
/// its translations and for any key it does not provide.
fn fallback(key: &str) -> &'static str {
    match key {
        "menu.app" => "AlmaStudio",
        "menu.settings" => "Settings…",
        "menu.checkUpdates" => "Check for Updates…",
        "menu.quit" => "Quit AlmaStudio",
        "menu.file" => "File",
        "menu.newProject" => "New Project…",
        "menu.openFolder" => "Open Folder as Tab…",
        "menu.newClaude" => "New Claude Code Tab",
        "menu.newCodex" => "New Codex Tab",
        "menu.newOpenCode" => "New OpenCode Tab",
        "menu.newTerminal" => "New Terminal Tab",
        "menu.newBrowser" => "New Browser Tab",
        "menu.closeTab" => "Close Tab",
        "menu.edit" => "Edit",
        "menu.undo" => "Undo",
        "menu.redo" => "Redo",
        "menu.cut" => "Cut",
        "menu.copy" => "Copy",
        "menu.paste" => "Paste",
        "menu.selectAll" => "Select All",
        "menu.find" => "Find in Terminal…",
        "menu.findInFiles" => "Find in Files…",
        "menu.view" => "View",
        "menu.toggleSidebar" => "Toggle Projects Sidebar",
        "menu.togglePanel" => "Toggle Right Panel",
        "menu.panelChanges" => "Changed Files",
        "menu.panelFiles" => "All Files",
        "menu.panelGit" => "Git",
        "menu.panelSearch" => "Search",
        "menu.splitRight" => "Split Right",
        "menu.splitDown" => "Split Down",
        "menu.closePane" => "Close Pane",
        "menu.nextTab" => "Next Tab",
        "menu.prevTab" => "Previous Tab",
        "menu.zoomIn" => "Zoom In",
        "menu.zoomOut" => "Zoom Out",
        "menu.zoomReset" => "Actual Size",
        "menu.window" => "Window",
        "menu.minimize" => "Minimize",
        "menu.zoom" => "Zoom",
        "menu.close" => "Close Window",
        "menu.help" => "Help",
        "menu.docs" => "AlmaStudio Documentation",
        "menu.revealState" => "Reveal Application Data…",
        _ => "",
    }
}

struct Labels(HashMap<String, String>);

impl Labels {
    fn get(&self, key: &str) -> String {
        match self.0.get(key) {
            Some(v) if !v.trim().is_empty() => v.clone(),
            _ => fallback(key).to_string(),
        }
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, labels: HashMap<String, String>) -> tauri::Result<()> {
    let l = Labels(labels);

    let settings = MenuItemBuilder::with_id("settings", l.get("menu.settings"))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", l.get("menu.checkUpdates")).build(app)?;

    let new_project = MenuItemBuilder::with_id("new-project", l.get("menu.newProject"))
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", l.get("menu.openFolder"))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let new_claude = MenuItemBuilder::with_id("new-tab-claude", l.get("menu.newClaude"))
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_codex = MenuItemBuilder::with_id("new-tab-codex", l.get("menu.newCodex"))
        .accelerator("CmdOrCtrl+Shift+C")
        .build(app)?;
    let new_opencode = MenuItemBuilder::with_id("new-tab-opencode", l.get("menu.newOpenCode"))
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let new_terminal = MenuItemBuilder::with_id("new-tab-terminal", l.get("menu.newTerminal"))
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let new_browser = MenuItemBuilder::with_id("new-tab-browser", l.get("menu.newBrowser"))
        .accelerator("CmdOrCtrl+Shift+B")
        .build(app)?;
    // ⌘W closes the focused pane — the whole tab when it is not split — and
    // ⇧⌘W the tab with every pane in it.
    let close_tab = MenuItemBuilder::with_id("close-tab", l.get("menu.closeTab"))
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;

    let find = MenuItemBuilder::with_id("find", l.get("menu.find"))
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let find_in_files = MenuItemBuilder::with_id("find-in-files", l.get("menu.findInFiles"))
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;

    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", l.get("menu.toggleSidebar"))
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_panel = MenuItemBuilder::with_id("toggle-panel", l.get("menu.togglePanel"))
        .accelerator("CmdOrCtrl+Alt+B")
        .build(app)?;
    let panel_changes = MenuItemBuilder::with_id("panel-changes", l.get("menu.panelChanges"))
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let panel_files = MenuItemBuilder::with_id("panel-files", l.get("menu.panelFiles"))
        .accelerator("CmdOrCtrl+2")
        .build(app)?;
    let panel_git = MenuItemBuilder::with_id("panel-git", l.get("menu.panelGit"))
        .accelerator("CmdOrCtrl+3")
        .build(app)?;
    let panel_search = MenuItemBuilder::with_id("panel-search", l.get("menu.panelSearch"))
        .accelerator("CmdOrCtrl+4")
        .build(app)?;
    let split_right = MenuItemBuilder::with_id("split-right", l.get("menu.splitRight"))
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let split_down = MenuItemBuilder::with_id("split-down", l.get("menu.splitDown"))
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;
    let close_pane = MenuItemBuilder::with_id("close-pane", l.get("menu.closePane"))
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next-tab", l.get("menu.nextTab"))
        .accelerator("Ctrl+Tab")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev-tab", l.get("menu.prevTab"))
        .accelerator("Ctrl+Shift+Tab")
        .build(app)?;
    // muda has no key name for "+": the "CmdOrCtrl+Plus" this used to say
    // parsed to nothing, and Tauri drops an unparsable accelerator silently,
    // so Zoom In had no shortcut at all. On macOS the numpad-plus code becomes
    // the key equivalent "+", which matches the "+" key on any layout and
    // shows as ⌘+. Elsewhere it would mean the numpad key only, so the "=" key
    // (an unshifted "+" on US layouts) is bound instead. The frontend catches
    // the remaining ways of typing "+" (see useMenuActions).
    #[cfg(target_os = "macos")]
    const ZOOM_IN: &str = "CmdOrCtrl+NumpadAdd";
    #[cfg(not(target_os = "macos"))]
    const ZOOM_IN: &str = "CmdOrCtrl+=";
    let zoom_in = MenuItemBuilder::with_id("zoom-in", l.get("menu.zoomIn"))
        .accelerator(ZOOM_IN)
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", l.get("menu.zoomOut"))
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", l.get("menu.zoomReset"))
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let docs = MenuItemBuilder::with_id("docs", l.get("menu.docs")).build(app)?;
    let reveal_state =
        MenuItemBuilder::with_id("reveal-state", l.get("menu.revealState")).build(app)?;

    let mut menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, l.get("menu.app"))
            .about(Some(AboutMetadata {
                name: Some("AlmaStudio".into()),
                version: Some(app.package_info().version.to_string()),
                copyright: Some("© Almaware".into()),
                website: Some("https://almaware.net".into()),
                ..Default::default()
            }))
            .separator()
            .item(&check_updates)
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    // Reassigned only on non-macOS, where Settings/Quit live in this menu.
    #[allow(unused_mut)]
    let mut file = SubmenuBuilder::new(app, l.get("menu.file"))
        .item(&new_project)
        .item(&open_folder)
        .separator()
        .item(&new_claude)
        .item(&new_codex)
        .item(&new_opencode)
        .item(&new_terminal)
        .item(&new_browser)
        .separator()
        .item(&close_pane)
        .item(&close_tab);
    #[cfg(not(target_os = "macos"))]
    {
        file = file.separator().item(&settings).item(&check_updates).separator().quit();
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, l.get("menu.edit"))
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .item(&find_in_files)
        .build()?;

    let view = SubmenuBuilder::new(app, l.get("menu.view"))
        .item(&toggle_sidebar)
        .item(&toggle_panel)
        .separator()
        .item(&panel_changes)
        .item(&panel_files)
        .item(&panel_git)
        .item(&panel_search)
        .separator()
        .item(&split_right)
        .item(&split_down)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    let window = SubmenuBuilder::new(app, l.get("menu.window"))
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let help = SubmenuBuilder::new(app, l.get("menu.help"))
        .item(&docs)
        .item(&reveal_state)
        .build()?;

    let menu = menu
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

/// Rebuilds the menu with translated labels. Called by the frontend once its
/// locale is known and whenever the user changes language.
#[tauri::command]
pub fn apply_menu(app: AppHandle, labels: HashMap<String, String>) -> Result<(), String> {
    build(&app, labels).map_err(|e| e.to_string())
}

pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu://action", id.to_string());
}
