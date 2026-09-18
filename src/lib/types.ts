/** Shared domain types. Mirrors the serde structs in src-tauri. */

export type HarnessKind = 'claude' | 'codex' | 'opencode' | 'shell'
export type TabKind = HarnessKind | 'diff' | 'file' | 'browser' | 'graph'
export type DiffSide = 'worktree' | 'index' | 'head'
export type PanelView = 'changes' | 'files' | 'git' | 'search'
export type ThemeMode = 'system' | 'dark' | 'light'
export type Language = 'system' | 'en' | 'it'

export interface Project {
  id: string
  name: string
  /** Emoji shown in the sidebar when no image is set. */
  icon: string
  /** Optional image icon as a small PNG data URL; takes precedence over `icon`. */
  iconImage?: string
  /**
   * Optional app icon — a name from `PROJECT_ICONS` — drawn in the project's
   * colour. Takes precedence over `icon`, but not over `iconImage`.
   */
  iconName?: string
  /** Accent dot colour, hex. */
  color: string
  /** Sidebar category the project is listed under; none when absent. */
  category?: string
  /** Main folder. Only the default cwd for new tabs — tabs may live anywhere. */
  root: string
  /** Repositories found beneath `root` that the panel lists first, by path. */
  pinnedRepos?: string[]
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

/**
 * A file or diff opened with a single click, as VS Code's preview editors
 * are: the next one opened that way takes its place, until it is pinned by a
 * double click or an edit.
 */
interface Previewable {
  preview?: boolean
}

export interface DiffTab extends TabBase, Previewable {
  kind: 'diff'
  /** Repository root the diff is computed against. */
  root: string
  /** Repo-relative path. */
  path: string
  side: DiffSide
  /** A commit whose change to the file is shown, instead of the working tree's. */
  target?: string
  /** Compared with this commit rather than `target`'s first parent. */
  base?: string
  /** The file's name before a rename in that change. */
  oldPath?: string
}

/** Where a file tab puts the cursor, when opened from a search result. */
export interface FileReveal {
  /** 1-based. */
  line: number
  /** UTF-16 offset in the line, and how much to select from there. */
  column: number
  length: number
  /** Tells asking for the same spot twice apart from a re-render. */
  nonce: number
}

export interface FileTab extends TabBase, Previewable {
  kind: 'file'
  root: string
  path: string
  reveal?: FileReveal
}

export interface BrowserTab extends TabBase {
  kind: 'browser'
  /** Last committed address, so the tab reopens where it was left. */
  url: string
}

/** A repository's commit graph, as a tab of its own. */
export interface GraphTab extends TabBase {
  kind: 'graph'
  root: string
}

export type Tab = TerminalTab | DiffTab | FileTab | BrowserTab | GraphTab

export const isTerminalTab = (t: Tab): t is TerminalTab =>
  t.kind === 'claude' || t.kind === 'codex' || t.kind === 'opencode' || t.kind === 'shell'

/** A preview, which the next file or diff opened with a single click replaces. */
export const isPreview = (t: Tab): t is FileTab | DiffTab =>
  (t.kind === 'file' || t.kind === 'diff') && !!t.preview

// --------------------------------------------------------------- layout ----

/** A pane: one session, tiled beside the others in its tab. */
export interface LeafNode {
  type: 'leaf'
  id: string
  tabId: string
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
  /**
   * Folder the panel is locked to. Null means it follows the active tab's
   * folder instead. Persisted, hence the historical name.
   */
  pinnedRoot: string | null
}

/**
 * A top-level tab. It shows one session, or several tiled side by side once it
 * has been split; splitting it leaves every other tab as it was.
 */
export interface TabGroup {
  id: string
  layout: LayoutNode
  /** The pane with focus inside this tab. */
  activePaneId: string
}

export interface ProjectWorkspace {
  /** Top-level tabs in strip order. The sessions they show live in `WorkspaceState.tabs`. */
  groups: TabGroup[]
  activeGroupId: string | null
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
  /** Sidebar categories folded shut. */
  collapsedCategories: string[]
}

// ------------------------------------------------------------- settings ----

/**
 * How much Codex may do before asking, when a tab starts it: `config` adds no
 * flags and leaves it to ~/.codex/config.toml.
 */
export type CodexApproval = 'config' | 'suggest' | 'auto' | 'full-auto'

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
  /** Codex only. */
  approval?: CodexApproval
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
    /**
     * macOS: Option sends ESC + key (Meta) instead of typing the character
     * the keyboard layout puts on it.
     */
    optionIsMeta: boolean
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
    /** Fetch the repository in view every so many minutes; 0 turns it off. */
    autoFetchMinutes: number
  }
  startup: {
    restoreTabs: boolean
    restoreScrollback: boolean
    autoStartTabs: boolean
    /** Ask before quitting while agents are running or edits are unsaved. */
    confirmOnExit: boolean
  }
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
  /** An operation under way, waiting on conflicts or a decision. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null
}

export interface StashInfo {
  /** Position in the stash list: `stash@{index}`. */
  index: number
  message: string
  id: string
  time: number
}

export interface TagInfo {
  name: string
  /** The commit it points at, abbreviated. */
  target: string
}

export interface CommitFile {
  path: string
  /** The name before a rename. */
  oldPath: string | null
  status: string
  additions: number
  deletions: number
  binary: boolean
}

export interface CommitDetails {
  id: string
  shortId: string
  parents: string[]
  /** The whole message, subject and body. */
  message: string
  author: string
  email: string
  authorTime: number
  committer: string
  committerEmail: string
  commitTime: number
  /** What changed against the first parent. */
  files: CommitFile[]
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

export interface RefLabel {
  name: string
  kind: 'branch' | 'remote' | 'tag' | 'head'
  /** The branch checked out, or a detached HEAD. */
  current: boolean
}

/** A commit in the graph: every branch's history, children before parents. */
export interface GraphCommit {
  id: string
  shortId: string
  parents: string[]
  summary: string
  author: string
  email: string
  time: number
  refs: RefLabel[]
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
