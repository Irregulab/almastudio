/** Typed wrappers around the Rust commands. */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AppInfo, BranchInfo, ChangedFile, CommitInfo, DiffSide, DirEntryInfo,
  FileContent, FileDiff, RepoStatus,
} from './types'

// ------------------------------------------------------------------ app ----

export const appInfo = () => invoke<AppInfo>('app_info')
export const signalReady = () => invoke<void>('ready')
export const defaultShell = () => invoke<string>('default_shell')
export const applyMenu = (labels: Record<string, string>) =>
  invoke<void>('apply_menu', { labels })

// ------------------------------------------------------------------ pty ----

export interface SpawnOptions {
  id: string
  cwd: string
  program: string
  args: string[]
  env: Record<string, string>
  loginShell: boolean
  shell: string | null
  cols: number
  rows: number
}

export const ptySpawn = (options: SpawnOptions) => invoke<void>('pty_spawn', { options })
export const ptyWrite = (id: string, data: string) => invoke<void>('pty_write', { id, data })
export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows })
export const ptyKill = (id: string) => invoke<void>('pty_kill', { id })
export const ptyStatus = (id: string) =>
  invoke<{ running: boolean; alive: boolean; exitCode: number }>('pty_status', { id })

/** `end` is the cumulative byte offset of the session stream after this batch. */
export const onPtyData = (
  id: string,
  cb: (bytes: Uint8Array, end: number) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; b64: string; end: number }>(`pty://data/${id}`, (e) =>
    cb(decodeBase64(e.payload.b64), e.payload.end),
  )

export const onPtyExit = (id: string, cb: (code: number) => void): Promise<UnlistenFn> =>
  listen<{ id: string; code: number }>(`pty://exit/${id}`, (e) => cb(e.payload.code))

/** `Uint8Array.fromBase64` where available; the manual path is the fallback. */
const fromBase64 = (
  Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
).fromBase64

export function decodeBase64(b64: string): Uint8Array {
  if (fromBase64) return fromBase64(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- state ----

export const stateLoad = (key: string) => invoke<string | null>('state_load', { key })
export const stateSave = (key: string, value: string) =>
  invoke<void>('state_save', { key, value })
export const stateDirPath = () => invoke<string>('state_dir_path')

export interface Scrollback {
  bytes: Uint8Array
  /** Stream offset the snapshot ends at; only meaningful when `live`. */
  end: number
  live: boolean
}

export const scrollbackLoad = async (id: string): Promise<Scrollback> => {
  const r = await invoke<{ b64: string; end: number; live: boolean }>('scrollback_load', { id })
  return {
    bytes: r.b64 ? decodeBase64(r.b64) : new Uint8Array(0),
    end: r.end,
    live: r.live,
  }
}
export const scrollbackPrune = (keep: string[]) => invoke<void>('scrollback_prune', { keep })
export const scrollbackForget = (id: string) => invoke<void>('scrollback_forget', { id })

// ------------------------------------------------------------------ git ----

export const gitStatus = (root: string) => invoke<RepoStatus>('git_status', { root })
export const gitDiffFile = (root: string, path: string, side: DiffSide, contextLines?: number) =>
  invoke<FileDiff>('git_diff_file', { root, path, side, contextLines })
export const gitStage = (root: string, paths: string[]) => invoke<void>('git_stage', { root, paths })
export const gitUnstage = (root: string, paths: string[]) =>
  invoke<void>('git_unstage', { root, paths })
export const gitDiscard = (root: string, paths: string[]) =>
  invoke<void>('git_discard', { root, paths })
export const gitCommit = (root: string, message: string, stageAll: boolean) =>
  invoke<string>('git_commit', { root, message, stageAll })
export const gitLog = (root: string, limit?: number) =>
  invoke<CommitInfo[]>('git_log', { root, limit })
export const gitBranches = (root: string) => invoke<BranchInfo[]>('git_branches', { root })
export const gitCheckout = (root: string, name: string) =>
  invoke<void>('git_checkout', { root, name })

export type { ChangedFile }

// ------------------------------------------------------------------- fs ----

export const listDir = (
  root: string, dir: string, showHidden: boolean, respectGitignore: boolean,
) => invoke<DirEntryInfo[]>('list_dir', { root, dir, showHidden, respectGitignore })

export const readTextFile = (path: string) => invoke<FileContent>('read_text_file', { path })
export const findFiles = (root: string, query: string, limit?: number) =>
  invoke<DirEntryInfo[]>('find_files', { root, query, limit })
export const dirName = (path: string) => invoke<string>('dir_name', { path })
export const writeProjectInstructions = (root: string, contents: string) =>
  invoke<string>('write_project_instructions', { root, contents })

// -------------------------------------------------------------- watcher ----

export const watchStart = (id: string, path: string) =>
  invoke<void>('watch_start', { id, path })
export const watchStop = (id: string) => invoke<void>('watch_stop', { id })

export interface ChangePayload {
  id: string
  paths: string[]
  gitMeta: boolean
  count: number
}

export const onFsChange = (id: string, cb: (p: ChangePayload) => void): Promise<UnlistenFn> =>
  listen<ChangePayload>(`fs://changed/${id}`, (e) => cb(e.payload))

// ----------------------------------------------------------------- menu ----

export const onMenuAction = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu://action', (e) => cb(e.payload))

// ------------------------------------------------------ fs mutation ---------

export const createDir = (path: string) => invoke<string>('create_dir', { path })
export const createFile = (path: string) => invoke<string>('create_file', { path })
export const renamePath = (from: string, to: string) =>
  invoke<string>('rename_path', { from, to })
/** Moves to the OS trash rather than deleting outright. */
export const trashPath = (path: string) => invoke<void>('trash_path', { path })
export const writeTextFile = (path: string, contents: string) =>
  invoke<void>('write_text_file', { path, contents })
export const readFileBase64 = (path: string, maxBytes?: number) =>
  invoke<string>('read_file_base64', { path, maxBytes })

// --------------------------------------------------------- pty activity ----

export interface ActivityPayload {
  id: string
  busy: boolean
}

/** Busy/idle transitions for every session, on one shared channel. */
export const onPtyActivity = (cb: (p: ActivityPayload) => void): Promise<UnlistenFn> =>
  listen<ActivityPayload>('pty://activity', (e) => cb(e.payload))

// -------------------------------------------------------------- browser ----

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const browserOpen = (id: string, url: string, bounds: Bounds) =>
  invoke<string>('browser_open', { id, url, bounds })
export const browserSetBounds = (id: string, bounds: Bounds) =>
  invoke<void>('browser_set_bounds', { id, bounds })
export const browserSetVisible = (id: string, visible: boolean) =>
  invoke<void>('browser_set_visible', { id, visible })
export const browserNavigate = (id: string, url: string) =>
  invoke<string>('browser_navigate', { id, url })
export const browserCommand = (id: string, action: 'back' | 'forward' | 'reload' | 'stop') =>
  invoke<void>('browser_command', { id, action })
export const browserState = (id: string) =>
  invoke<{ url: string; exists: boolean }>('browser_state', { id })
export const browserClose = (id: string) => invoke<void>('browser_close', { id })

export interface NavigatedPayload {
  id: string
  url: string
}

/** Fired for every navigation a browser view makes, including link clicks. */
export const onBrowserNavigated = (
  cb: (p: NavigatedPayload) => void,
): Promise<UnlistenFn> =>
  listen<NavigatedPayload>('browser://navigated', (e) => cb(e.payload))

// ------------------------------------------------------------------ exit ----

export const confirmExit = () => invoke<void>('confirm_exit')
export const cancelExit = () => invoke<void>('cancel_exit')

/** The backend asks before shutting down; nothing closes until we answer. */
export const onCloseRequested = (cb: () => void): Promise<UnlistenFn> =>
  listen('app://close-requested', () => cb())

// ------------------------------------------------------- repo discovery ----

export interface RepoEntry {
  path: string
  name: string
  rel: string
  branch: string | null
  dirty: number
}

export const findGitRepos = (root: string, maxDepth?: number) =>
  invoke<RepoEntry[]>('find_git_repos', { root, maxDepth })
