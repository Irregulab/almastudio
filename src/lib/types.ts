/** Shared domain types. Mirrors the serde structs in src-tauri. */

export type HarnessKind = 'claude' | 'codex' | 'shell'
export type TabKind = HarnessKind | 'diff' | 'file'
export type DiffSide = 'worktree' | 'index' | 'head'
export type PanelView = 'changes' | 'files' | 'git'
export type ThemeMode = 'system' | 'dark' | 'light'
export type Language = 'system' | 'en' | 'it'

export interface Project {
  id: string
  name: string
  /** Emoji shown in the sidebar when no image is set. */
  icon: string
  /** Optional image icon as a small PNG data URL; takes precedence over `icon`. */
  iconImage?: string
  /** Accent dot colour, hex. */
  color: string
  /** Main folder. Only the default cwd for new tabs — tabs may live anywhere. */
  root: string
  /** Extra instructions handed to the AI harness for this project. */
  instructions: string
  defaultHarness: HarnessKind | 'default'
  createdAt: number
  lastOpenedAt: number
}

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited'

interface TabBase {
  id: string
  projectId: string
  title: string
  /** True when the title was set by the user and should not be regenerated. */
  renamed?: boolean
}

export interface TerminalTab extends TabBase {
  kind: HarnessKind
  /** Any folder on the machine; defaults to the project root at creation. */
  cwd: string
  status: TerminalStatus
  exitCode?: number
  /** Ask the harness to resume its previous session when restarting. */
  resumeOnRestore: boolean
  /**
   * True for tabs brought back from a previous run. Creating a tab is itself
   * the instruction to start it, so only restored tabs consult the
   * auto-start setting.
   */
  restored?: boolean
}

export interface DiffTab extends TabBase {
  kind: 'diff'
  /** Repository root the diff is computed against. */
  root: string
  /** Repo-relative path. */
  path: string
  side: DiffSide
}

export interface FileTab extends TabBase {
  kind: 'file'
  root: string
  path: string
}

export type Tab = TerminalTab | DiffTab | FileTab

export const isTerminalTab = (t: Tab): t is TerminalTab =>
  t.kind === 'claude' || t.kind === 'codex' || t.kind === 'shell'

// --------------------------------------------------------------- layout ----

export interface LeafNode {
  type: 'leaf'
  id: string
  tabIds: string[]
  activeTabId: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  dir: 'row' | 'col'
  /** Fractions summing to 1, one per child. */
  sizes: number[]
  children: LayoutNode[]
}

export type LayoutNode = LeafNode | SplitNode

export interface PanelState {
  open: boolean
  view: PanelView
  width: number
  /** When set, the panel inspects this folder instead of the active tab's. */
  pinnedRoot: string | null
}

export interface ProjectWorkspace {
  layout: LayoutNode
  activePaneId: string
  panel: PanelState
}

export interface WorkspaceState {
  version: number
  projects: Project[]
  tabs: Record<string, Tab>
  workspaces: Record<string, ProjectWorkspace>
  activeProjectId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
}

// ------------------------------------------------------------- settings ----

export interface HarnessConfig {
  /** Executable name or absolute path. */
  command: string
  /** Arguments for a fresh session. */
  args: string[]
  /** Arguments used instead when resuming after a restart. */
  resumeArgs: string[]
  /**
   * How project instructions reach the agent, on top of the always-written
   * `.almastudio/instructions.md` and the ALMASTUDIO_INSTRUCTIONS env var.
   * `flag` appends `instructionsFlag` followed by the text.
   */
  instructionsMode: 'flag' | 'env' | 'none'
  instructionsFlag: string
}

export interface Settings {
  version: number
  /** Dark / light / follow the OS. */
  theme: ThemeMode
  /** Theme family id from the UI theme registry, e.g. 'vscode'. */
  uiTheme: string
  /** Optional accent override; empty means "use the theme's accent". */
  accent: string
  language: Language
  ui: { fontFamily: string; fontSize: number; density: 'comfortable' | 'compact' }
  terminal: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    cursorStyle: 'block' | 'underline' | 'bar'
    cursorBlink: boolean
    scrollback: number
    copyOnSelect: boolean
    rightClickPaste: boolean
    scheme: string
    /** Overrides $SHELL for terminal tabs. Empty means use the system default. */
    shell: string
    /** Run harnesses through a login shell so PATH matches a real terminal. */
    loginShell: boolean
  }
  defaultHarness: HarnessKind
  harness: Record<HarnessKind, HarnessConfig>
  panel: {
    defaultView: PanelView
    showHidden: boolean
    respectGitignore: boolean
    watch: boolean
    diffView: 'unified' | 'split'
    contextLines: number
  }
  startup: { restoreTabs: boolean; restoreScrollback: boolean; autoStartTabs: boolean }
  updates: { autoCheck: boolean; intervalHours: number }
}

// ------------------------------------------------------------------ git ----

export interface ChangedFile {
  path: string
  oldPath: string | null
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  deleted: boolean
}

export interface RepoStatus {
  isRepo: boolean
  root: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  files: ChangedFile[]
}

export interface DiffLine {
  origin: string
  oldLineno: number | null
  newLineno: number | null
  content: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath: string | null
  binary: boolean
  truncated: boolean
  additions: number
  deletions: number
  status: string
  hunks: DiffHunk[]
}

export interface CommitInfo {
  id: string
  shortId: string
  summary: string
  author: string
  email: string
  time: number
}

export interface BranchInfo {
  name: string
  isHead: boolean
  isRemote: boolean
}

// ------------------------------------------------------------------- fs ----

export interface DirEntryInfo {
  name: string
  path: string
  rel: string
  isDir: boolean
  isSymlink: boolean
  size: number
}

export interface FileContent {
  path: string
  content: string
  size: number
  binary: boolean
  truncated: boolean
}

export interface AppInfo {
  version: string
  name: string
  tauriVersion: string
  os: string
  arch: string
  debug: boolean
}
