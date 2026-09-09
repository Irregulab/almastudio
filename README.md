# AlmaStudio

A desktop workspace for AI coding agents. Projects on the left, Claude Code /
Codex / shell tabs in the middle (tiled if you want), and a git, file and diff
panel on the right.

Built with Tauri 2 (Rust) and React. The whole UI is one webview and a handful
of blocked threads — no Electron, no per-tab browser process.

## Features

- **Projects** — name, icon, colour, a main folder and its own instructions for
  the AI harness. The main folder is only the *default* for new tabs; any tab
  can be opened in any folder on the machine.
- **Tabs** — each tab runs Claude Code, Codex or a plain shell in a real PTY,
  or shows a diff or a file. Opening a tab starts it immediately; only tabs
  restored from a previous run consult the auto-start setting. Split panes
  horizontally and vertically, drag tabs between them.
- **Right panel** — three views: changed files, the full file tree, and git
  (branch, staging, commit, history, branch switching). Clicking a changed file
  opens its diff as a tab in the main area.
- **Code and Markdown** — syntax highlighting in both the file view and diffs,
  themed from the same tokens as the rest of the app. Markdown files open as a
  rendered preview with a toggle back to source.
- **Survives restarts** — projects, tabs, folders, tile layout and recent
  terminal output are written to disk continuously, so an app restart or a
  machine reboot brings the workspace back. Agents can be relaunched with their
  resume flags (`claude --continue`).
- **Themes and i18n** — dark, light or follow the system, using VS Code's
  Dark+ / Light+ palettes by default; English and Italian. Everything
  configurable lives in Settings, reachable from the app menu (⌘,).
- **Updates** — signed over-the-air updates served from almaware.net.

## Requirements

- Node 20+
- Rust stable (`rustup`)
- Platform toolchain: Xcode CLT on macOS, MSVC + WebView2 on Windows,
  `libwebkit2gtk-4.1-dev` and friends on Linux (see the release workflow for
  the exact package list).

## Development

```bash
npm install
npm start          # tauri dev: vite + the Rust backend, hot reloading
npm run typecheck  # tsc
npm run bundle     # tauri build: installers in src-tauri/target/release/bundle
```

## How the pieces fit

```
src/                     React frontend
  lib/         ipc.ts (typed command wrappers), layout.ts (tiling tree),
               harness.ts (tab → process), wordDiff.ts,
               uiThemes.ts + schemes.ts (theme registry)
  store/       zustand: settings, workspace (projects/tabs/layout), ui
  components/  TerminalView, Pane/Tiles, RightPanel, DiffView, Settings, …
  i18n/        en.json, it.json + a ~40-line runtime

src-tauri/src/           Rust backend
  pty.rs       PTY sessions: spawn, read, resize, kill, scrollback ring
  git.rs       libgit2: status, diffs, staging, commit, log, branches
  fsx.rs       lazy directory listing, file reads, file finder
  watcher.rs   debounced filesystem watching
  store.rs     crash-safe persistence + scrollback flushing
  menu.rs      native menu, labels supplied by the frontend
```

### Design notes worth knowing

**Terminal throughput.** Each PTY session runs a reader thread and an emitter
thread. The reader blocks on `read()`; the emitter parks on a condvar and, when
woken, waits 8 ms before shipping one batch to the webview. Idle terminals cost
zero CPU (there are no polling timers anywhere), and a burst of output collapses
into ~80 IPC messages per second instead of thousands.

**No lost or duplicated output.** Every batch carries a cumulative byte offset.
When a tab re-attaches to a session that is still running, it subscribes first,
then takes a snapshot of the server-side ring buffer, and uses the offsets to
discard exactly the batches the snapshot already covered.

**Highlighting is lazy and themed.** highlight.js core plus an explicit
language list loads as its own chunk on first use, so a session that only ever
shows terminals never pays for it. Colours come from `--syn-*` theme tokens
rather than a bundled stylesheet, which is why highlighting follows the theme.
In diffs the syntax tokens and the word-level diff segments are two partitions
of the same line, merged by cutting a run at every boundary from either side —
so a renamed identifier shows as both changed *and* an identifier. Hunks are
highlighted as fragments, so one that begins inside a block comment can colour
oddly until the next hunk.

**Markdown previews are sanitised.** A README from a cloned repository is
untrusted text, so parsed HTML goes through DOMPurify before it reaches the
DOM, on top of the CSP that already blocks inline scripts. Remote images do not
load: allowing them would let a preview phone home to a third party. Links open
in the system browser rather than navigating the app's own webview.

**Only the active project is mounted.** Switching projects disposes the
terminals of the one you left but never kills its processes; coming back
re-attaches and replays the server-side ring buffer. So ten open projects cost
roughly what one does in the webview, while their agents keep working.

**Crash-safe state.** Settings and the workspace are written on a 300–400 ms
debounce, never only at exit — a power cut gives you no shutdown hook. Each
write goes to a temp file, is fsynced, the current file is rotated to `.bak`,
and the temp is renamed into place. Both renames are atomic, so a crash at any
instant leaves at least one readable file and the loader prefers the primary.

**PATH.** A bundled macOS app inherits a bare PATH from launchd and would never
find `claude`. Agents are therefore launched through a login shell
(`$SHELL -l -c 'exec claude …'`), which is what a real terminal does, so nvm,
mise, asdf and Homebrew all work. On Windows the command goes through
`cmd /c` so npm's `.cmd` shims resolve. This is togglable in Settings.

**Themes are data.** A theme is a map of CSS custom properties with a dark and
a light variant plus the terminal palette that pairs with it, listed in
`src/lib/uiThemes.ts`; the app writes the selected one onto `:root` at boot.
Adding a theme means adding an entry to that array — no stylesheet changes. The
CSS carries a matching fallback for the first paint. VS Code and Almaware ship
in the box.

**Project instructions** reach the agent three ways at once: written to
`.almastudio/instructions.md` in the project, exported as
`ALMASTUDIO_INSTRUCTIONS`, and — for harnesses that support it — passed as a
flag (`claude --append-system-prompt …`). The flag is editable per harness in
Settings, so a new agent CLI can be wired up without a code change. The
`.almastudio/` folder contains a `.gitignore` that ignores itself, so it never
shows up in the project's git status.

## Tests

```bash
npm test                                    # layout tree, word diff, settings merge
cargo test --manifest-path src-tauri/Cargo.toml   # pty command building, ring buffer
npm run check                               # typecheck + both suites
```

The Rust suite includes a real PTY spawn through a login shell, which is the
thing most likely to break silently on a packaged build.

## Configuration

Everything is in **Settings** (⌘, or the sidebar button): theme and accent,
language, UI and terminal fonts, terminal colour scheme and behaviour, the
command / arguments / resume-arguments for each harness, panel defaults,
restore behaviour and updates.

State lives in the OS application-data directory; Settings → About shows the
exact path and can reveal it.

## Releasing

See [docs/UPDATES.md](docs/UPDATES.md).

## Licence

MIT.
