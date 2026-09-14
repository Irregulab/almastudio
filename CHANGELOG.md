# Changelog

All notable changes to AlmaStudio. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version's section is published as its GitHub release notes, and a
release cannot be cut without one — see `docs/UPDATES.md`.

## [Unreleased]

## [1.2.0] - 2026-09-14

### Added

- Search across a folder's files from the right panel, as in VS Code: match
  case, whole words and regular expressions, files to include and exclude,
  and results grouped by file. Clicking a result opens the file at that line.
  Find in Files (⇧⌘F) goes straight to it.
- Visual Studio Code from the + menu. With VS Code's command-line tools
  installed it opens inside AlmaStudio as a tab, served on this machine only
  and behind a token; otherwise VS Code opens in its own window.

## [1.1.1] - 2026-09-11

### Fixed

- The interface fits its window again. After the window had once been wider
  than the screen, the app could open with everything laid out wider than
  the window — the title off-centre, the right panel and its buttons cut off
  — and resizing did not help. The page is now sized to the window as it
  actually is, every time it changes, and a saved size too big for the
  screen is trimmed once the window is shown.

## [1.1.0] - 2026-09-11

### Added

- Projects can be grouped by category. Give a project a category in its
  settings and the sidebar lists it under that heading, in a section that
  folds away with a click; projects without one stay at the top. Dragging a
  project among another category's projects moves it there.
- Repositories found beneath a project folder can be pinned in the Changes
  and Git panels, and pinned ones are listed first.

### Fixed

- "No tabs open", shown by a project with no tabs, is centred in the window
  again instead of sitting against the left edge.

## [1.0.9] - 2026-09-11

### Fixed

- Scripts and tools run in AlmaStudio's terminals can use Calendar and
  Reminders again. macOS asks the app hosting a terminal for that access, and
  AlmaStudio did not declare it, so the request was refused without a prompt
  and AlmaStudio never appeared under Calendars or Reminders in System
  Settings. It now asks the first time, the way iTerm does.
- A Claude Code tab no longer starts with its text out of place, with
  `^[[I^[[?1;2c` near the top, until the window was resized. Replaying the
  tab's previous output made the terminal answer the questions Claude Code
  had asked of it last time, and the answers reached the new session as it
  started, shifting everything it drew after them.

## [1.0.8] - 2026-09-10

### Fixed

- The app no longer freezes after the Mac wakes from sleep. Saving the
  window's position from a background thread could deadlock against the
  window moving at the same moment, which is exactly what happens while the
  displays are reconfigured on wake; the window stopped responding for good
  and had to be force-quit.

## [1.0.7] - 2026-09-10

### Added

- A project's icon can be one of the app's own icons instead of an emoji,
  drawn in the project's colour.

### Fixed

- Links clicked in a terminal open in the default browser. The app could
  call "open URL" but had been given no URL it was allowed to open, so every
  link — in terminals, Markdown previews and Help → Documentation — was
  refused without a word. Links a program marks up itself (OSC 8) open too.
- Claude Code tabs resume their own conversation after a restart. They all
  continued the folder's most recent one, so three tabs on three sessions
  came back on the same. Each tab now records which session it is on,
  following /clear and /resume as well; tabs from before this version
  continue the latest conversation one last time.

## [1.0.6] - 2026-09-10

### Added

- Images (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) and PDFs open in a viewer
  instead of "binary file". Images sit on a checkerboard and switch between
  fit and actual size with a click.
- HTML and SVG files get a Preview beside their source, like Markdown. SVG
  previews follow unsaved edits; HTML pages render from the saved file with
  their stylesheets and images, and with scripts switched off.

### Changed

- Splits belong to a tab. Split Right and Split Down divide only the tab in
  front, and every other tab stays full screen. Each pane runs one session
  under a small header of its own, and a new pane starts the same kind of
  session in the same folder. Drag a tab onto a pane's edge to put it beside
  it, or use Move to New Tab to take a pane out again.
- ⌘W closes the focused pane (the tab, when it is not split); ⇧⌘W closes the
  whole tab.
- Existing layouts open with every session as a tab of its own.

## [1.0.5] - 2026-09-10

### Fixed

- Option key combinations type their character in terminals, whatever the
  keyboard layout: on an Italian keyboard Option+5 gives ~, and @ # [ ] { }
  work too. Option as a Meta key is now a choice in Settings → Terminal,
  off by default.
- On Windows, characters typed with AltGr in the file editor are typed
  rather than run as shortcuts: on an Italian keyboard [ and ] folded and
  unfolded the whole file, and on a German one \ re-indented it.

## [1.0.4] - 2026-09-10

### Fixed

- Shift+Enter in an agent tab starts a new line instead of sending the
  message.
- ⌘+ zooms in. Zoom In never had a working keyboard shortcut; ⌘= works too.
- Check for Updates… opens Settings on the Updates page, where the result of
  the check appears, instead of on Appearance.

## [1.0.3] - 2026-09-10

### Added

- OpenCode tabs, alongside Claude Code and Codex: from File → New OpenCode
  Tab (⇧⌘O), the + menu, or as a project's default tab type. Restarting a
  tab continues its last session.
- Dropping files from Finder or Explorer onto a terminal or agent tab types
  their paths into it, quoted for the shell, as a native terminal does.

### Changed

- Tabs and projects are dragged with the pointer rather than the browser's
  drag and drop, with a label that follows the pointer. Esc cancels a drag.

### Fixed

- Dropping a file anywhere in the window no longer replaces the app with the
  file's contents.
- With a Retina screen and a standard external monitor, the window could open
  with the whole interface squeezed into its top-left corner until it was
  resized.

## [1.0.2] - 2026-09-10

### Fixed

- Apple silicon Macs were offered the Intel update package, which failed
  verification: both builds were published under the same file name.
- Windows and Linux were missing from the update feed.

## [1.0.1] - 2026-09-10

### Added

- Quitting asks for confirmation.
- Repositories inside a project folder that is not itself a repository are
  found and listed as an accordion.

### Fixed

- The macOS app would not open ("AlmaStudio is damaged"): it is now signed
  with Developer ID and notarised by Apple.
- The window's position and size are remembered properly.

## [1.0.0] - 2026-09-10

First release.

### Added

- Projects in a reorderable sidebar, each with its own colour and icon.
- Claude Code, Codex and shell tabs in a tiling layout; tabs can be dragged
  between panes or onto a pane's edge to split it.
- A side panel with git status, staging, commits and diffs, and a file tree
  with create, rename and delete.
- Files open in tabs with syntax highlighting, editing and Markdown preview.
- Browser tabs.
- Terminal find, restart and stop, and an activity indicator showing when an
  agent is working or waiting.
- Themes, including VS Code, One and Dracula, in light and dark.
- English and Italian.
- Over-the-air updates.

[Unreleased]: https://github.com/Irregulab/almastudio/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Irregulab/almastudio/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Irregulab/almastudio/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Irregulab/almastudio/compare/v1.0.9...v1.1.0
[1.0.9]: https://github.com/Irregulab/almastudio/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/Irregulab/almastudio/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/Irregulab/almastudio/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/Irregulab/almastudio/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Irregulab/almastudio/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Irregulab/almastudio/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Irregulab/almastudio/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Irregulab/almastudio/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Irregulab/almastudio/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Irregulab/almastudio/releases/tag/v1.0.0
