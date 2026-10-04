/**
 * The companion protocol: what the desktop and the mobile app say to each
 * other once the Noise handshake is done. Every message is one JSON object.
 *
 *   app → desktop   { t: 'req', id, m, p }      a request
 *                   { t: 'ping' }
 *   desktop → app   { t: 'res', id, ok, r | e } its answer
 *                   { t: 'ev', e, d }           something happened
 *                   { t: 'pong' }
 *
 * The Rust side lives in src-tauri/src/remote; keep the two in step.
 */

export type {
  BranchInfo, ChangedFile, CommitDetails, CommitFile, DiffHunk, DiffLine, DirEntryInfo,
  FileContent, FileDiff, GraphCommit, RefLabel, RepoStatus,
} from '../../../src/lib/types'

export type HarnessKind = 'claude' | 'codex' | 'opencode' | 'shell'
export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited'

/** Bound into the Noise handshake; must match `PROLOGUE` in noise.rs. */
export const PROLOGUE = 'almastudio-remote-v1'
export const DEFAULT_PORT = 47821
/** Where the app connects when the desktop is not on the same network. */
export const DEFAULT_RELAY = 'wss://relay.almastudio.almaware.net'

// ------------------------------------------------------------- pairing ----

/** What the pairing QR code holds, base64url JSON in `almastudio://pair?d=`. */
export interface PairingPayload {
  v: 1
  /** The desktop's name. */
  n: string
  /** The desktop's static public key, base64url. */
  k: string
  /** `ip:port` on the local network. */
  a: string[]
  /** One-time pairing code. */
  t: string
  /** The relay, when access from anywhere is on. */
  r: string | null
}

/** First handshake message payload, app → desktop. */
export interface Hello {
  name: string
  platform: string
  app: string
  /** Only when pairing. */
  token?: string
}

/** Second handshake message payload, desktop → app. */
export interface Welcome {
  ok: boolean
  error?: 'not-paired' | 'invalid-code' | 'denied' | string
  desktop?: { name: string; version: string; os: string }
}

// ----------------------------------------------------------- workspace ----

export interface RemoteTab {
  id: string
  kind: HarnessKind
  title: string
  cwd: string
  status: TerminalStatus
  exitCode?: number
  /** The top-level tab it sits in on the desktop; split panes share one. */
  groupId: string
}

export interface RemoteProject {
  id: string
  name: string
  /** Emoji, when the project has no image or named icon. */
  icon: string
  color: string
  category?: string
  root: string
  pinnedRepos: string[]
  /** Terminal tabs, in the desktop's strip order. */
  tabs: RemoteTab[]
  /** The tab in front on the desktop. */
  activeTabId: string | null
}

/** The desktop's projects and terminals, as the app sees them. */
export interface RemoteWorkspace {
  activeProjectId: string | null
  projects: RemoteProject[]
  /** Harnesses installed on the desktop, which new tabs may run. */
  harnesses: HarnessKind[]
}

// ------------------------------------------------------------- methods ----

export interface Owner {
  /** The pty is sized for a remote client. */
  remote: boolean
  /** …and that client is this one. */
  mine: boolean
}

export interface DesktopInfo {
  name: string
  version: string
  os: string
  /** `ip:port` where it listens on the local network now. */
  addresses: string[]
  relay: string | null
}

export interface AttachResult {
  /** Scrollback, base64. */
  b64: string
  /** Stream offset the snapshot ends at, when `live`. */
  end: number
  /** The session is running; otherwise this is the output of its last run. */
  live: boolean
  alive: boolean
  exitCode: number
  owner: Owner
  /** The desktop terminal's size, for showing its full width. */
  desktopSize: TerminalSize
}

export interface TerminalSize {
  cols: number
  rows: number
}

/** Request params and results, by method. */
export interface Methods {
  'desktop.info': { p: Record<string, never>; r: DesktopInfo }
  'workspace.get': { p: Record<string, never>; r: { workspace: RemoteWorkspace | null; busy: string[] } }
  'term.attach': { p: { tabId: string }; r: AttachResult }
  'term.detach': { p: { tabId: string }; r: null }
  'term.input': { p: { tabId: string; data: string }; r: null }
  'term.resize': { p: { tabId: string } & TerminalSize; r: null }
  'term.release': { p: { tabId: string }; r: null }
  'tab.open': {
    p: { projectId: string; kind: HarnessKind; cwd?: string } & Partial<TerminalSize>
    r: { tabId: string }
  }
  'tab.close': { p: { tabId: string }; r: null }
  'tab.start': { p: { tabId: string } & Partial<TerminalSize>; r: null }
  'tab.restart': { p: { tabId: string } & Partial<TerminalSize>; r: null }
  'tab.kill': { p: { tabId: string }; r: null }
  'push.register': {
    p: { token: string; platform: string; hideNames?: boolean }
    r: null
  }
  'push.unregister': { p: Record<string, never>; r: null }
  'git.status': { p: { projectId: string; root?: string }; r: import('../../../src/lib/types').RepoStatus }
  'git.repos': { p: { projectId: string }; r: RepoEntry[] }
  'git.diff': {
    p: {
      projectId: string; root: string; path: string; side: 'worktree' | 'index'
      target?: string; base?: string; oldPath?: string
    }
    r: import('../../../src/lib/types').FileDiff
  }
  'git.graph': { p: { projectId: string; root: string; limit?: number }; r: import('../../../src/lib/types').GraphCommit[] }
  'git.commit': { p: { projectId: string; root: string; id: string }; r: import('../../../src/lib/types').CommitDetails }
  'fs.list': { p: { projectId: string; root?: string; dir: string }; r: import('../../../src/lib/types').DirEntryInfo[] }
  'fs.read': { p: { projectId: string; root?: string; path: string }; r: import('../../../src/lib/types').FileContent }
  'search.text': {
    p: { projectId: string; root?: string; pattern: string; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
    r: SearchResults
  }
}

export type Method = keyof Methods

/** A repository found in a project. */
export interface RepoEntry {
  path: string
  name: string
  /** Relative to the project folder. */
  rel: string
  branch: string | null
  /** Changed files. */
  dirty: number
}

export interface SearchResults {
  files: Array<{
    path: string
    rel: string
    matches: Array<{ line: number; column: number; length: number; preview: string }>
  }>
  matchCount: number
  truncated: boolean
  cancelled: boolean
}

// -------------------------------------------------------------- events ----

export type AgentEventKind = 'needs-input' | 'permission' | 'finished'

export interface Events {
  workspace: RemoteWorkspace
  'term.data': { tabId: string; b64: string; end: number }
  'term.exit': { tabId: string; code: number }
  'term.owner': { tabId: string } & Owner
  activity: { tabId: string; busy: boolean }
  agent: { tabId: string; projectId: string; kind: AgentEventKind; message?: string }
}

export type EventName = keyof Events

// ------------------------------------------------------------ messages ----

export type ClientMessage =
  | { t: 'req'; id: number; m: Method; p: unknown }
  | { t: 'ping' }

export type ServerMessage =
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: string }
  | { t: 'ev'; e: EventName; d: unknown }
  | { t: 'pong' }
