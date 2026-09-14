//! External editors — Visual Studio Code and IntelliJ IDEA — that the new-tab
//! menu offers to open the project folder in, when they are installed.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

struct Spec {
    id: &'static str,
    name: &'static str,
    /// macOS: the names the app bundle is installed under, and its bundle
    /// identifiers, for finding it anywhere else Spotlight knows of.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    app_names: &'static [&'static str],
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    bundle_ids: &'static [&'static str],
    /// Elsewhere: the command-line launchers the installers provide.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    launchers: &'static [&'static str],
}

/// In menu order.
const EDITORS: &[Spec] = &[
    Spec {
        id: "vscode",
        name: "Visual Studio Code",
        app_names: &["Visual Studio Code.app"],
        bundle_ids: &["com.microsoft.VSCode"],
        launchers: &["code"],
    },
    Spec {
        id: "intellij",
        name: "IntelliJ IDEA",
        app_names: &[
            "IntelliJ IDEA.app",
            "IntelliJ IDEA Ultimate.app",
            "IntelliJ IDEA CE.app",
            "IntelliJ IDEA Community Edition.app",
        ],
        bundle_ids: &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
        launchers: &["idea", "idea.sh", "intellij-idea-ultimate", "intellij-idea-community"],
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
}

/// The editors installed on this machine, in menu order.
#[tauri::command]
pub async fn external_editors() -> Vec<Editor> {
    tauri::async_runtime::spawn_blocking(|| {
        EDITORS
            .iter()
            .filter(|spec| locate(spec).is_some())
            .map(|spec| Editor { id: spec.id, name: spec.name })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Opens `folder` in the editor with id `editor`, in its own window.
#[tauri::command]
pub fn open_in_editor(editor: String, folder: String) -> Result<(), String> {
    let spec = EDITORS
        .iter()
        .find(|spec| spec.id == editor)
        .ok_or_else(|| format!("unknown editor {editor}"))?;
    let target = locate(spec).ok_or_else(|| format!("{} is not installed", spec.name))?;
    launch(&target, &folder).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ macOS ---

/// The app bundle.
#[cfg(target_os = "macos")]
fn locate(spec: &Spec) -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    // Where JetBrains Toolbox and per-user installs put apps.
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    for root in &roots {
        for name in spec.app_names {
            let app = root.join(name);
            if app.is_dir() {
                return Some(app);
            }
        }
    }
    for id in spec.bundle_ids {
        let Ok(out) = Command::new("mdfind")
            .arg(format!("kMDItemCFBundleIdentifier == '{id}'"))
            .output()
        else {
            continue;
        };
        let found = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(PathBuf::from)
            .find(|path| path.extension().is_some_and(|e| e == "app") && path.is_dir());
        if found.is_some() {
            return found;
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn launch(app: &Path, folder: &str) -> std::io::Result<()> {
    let status = Command::new("open").arg("-a").arg(app).arg(folder).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("`open` exited with {status}")))
    }
}

// ------------------------------------------------------ Linux and Windows ---

/// The command-line launcher.
#[cfg(not(target_os = "macos"))]
fn locate(spec: &Spec) -> Option<PathBuf> {
    let dirs = launcher_dirs();
    spec.launchers
        .iter()
        .flat_map(|launcher| launcher_files(launcher))
        .flat_map(|file| dirs.iter().map(move |dir| dir.join(&file)))
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "macos"))]
fn launch(launcher: &Path, folder: &str) -> std::io::Result<()> {
    use std::process::Stdio;
    let mut child = Command::new(launcher)
        .arg(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // Some launchers hand over and exit, others stay with the IDE; either way
    // the process is reaped when it ends.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn launcher_files(name: &str) -> Vec<String> {
    vec![format!("{name}.cmd"), format!("{name}.exe"), format!("{name}64.exe")]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launcher_files(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

/// The PATH, which a desktop launch may not have filled in, and the places
/// the installers use.
#[cfg(not(target_os = "macos"))]
fn launcher_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        dirs.extend(
            ["/usr/local/bin", "/usr/bin", "/snap/bin", "/usr/share/code/bin", "/opt/visual-studio-code/bin"]
                .map(PathBuf::from),
        );
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
        }
        dirs.extend(install_bins(Path::new("/opt"), "idea"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join(r"Programs\Microsoft VS Code\bin"));
            dirs.push(local.join(r"JetBrains\Toolbox\scripts"));
        }
        if let Some(programs) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(programs.join(r"Microsoft VS Code\bin"));
            dirs.extend(install_bins(&programs.join("JetBrains"), "idea"));
        }
    }
    dirs
}

/// The `bin` folders of installs named like "IntelliJ IDEA 2025.2" or
/// "idea-IU-252", which carry their version in the name.
#[cfg(not(target_os = "macos"))]
fn install_bins(parent: &Path, needle: &str) -> Vec<PathBuf> {
    std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().to_lowercase().contains(needle))
        .map(|entry| entry.path().join("bin"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_editor_can_be_found_on_every_platform() {
        let mut ids: Vec<&str> = EDITORS.iter().map(|spec| spec.id).collect();
        ids.dedup();
        assert_eq!(ids.len(), EDITORS.len(), "editor ids must be unique");
        for spec in EDITORS {
            assert!(!spec.app_names.is_empty() && !spec.bundle_ids.is_empty(), "{}", spec.id);
            assert!(!spec.launchers.is_empty(), "{}", spec.id);
        }
    }
}
