# Changelog

All notable changes to AlmaStudio. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version's section is published as its GitHub release notes, and a
release cannot be cut without one — see `docs/UPDATES.md`.

## [Unreleased]

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

[Unreleased]: https://github.com/Irregulab/almastudio/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/Irregulab/almastudio/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Irregulab/almastudio/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Irregulab/almastudio/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Irregulab/almastudio/releases/tag/v1.0.0
