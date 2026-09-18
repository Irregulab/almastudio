/** Turns a tab plus the user's settings into a concrete process to spawn. */

import type { SpawnOptions } from './ipc'
import type { CodexApproval, Project, Settings, TerminalTab } from './types'

export interface LaunchContext {
  tab: TerminalTab
  project: Project | undefined
  settings: Settings
  cols: number
  rows: number
  /** Use the harness's resume arguments instead of its normal ones. */
  resume: boolean
  /** Claude Code only: the tab's session record, see `ClaudeSession`. */
  claudeSession?: ClaudeSession
}

/**
 * Which Claude Code conversation a tab is on. `claude --continue` resumes the
 * folder's most recent conversation — the same one for every Claude tab open
 * in that folder — so each tab records its own session instead, through a
 * SessionStart hook writing to `file`, and resumes exactly that.
 */
export interface ClaudeSession {
  /** Where the tab's hook writes the session it is on. */
  file: string
  /**
   * What the record says: the session to resume; `gone` when the recorded
   * session has no transcript left to resume (it never got a first message);
   * `none` when nothing was recorded — a tab from before records existed.
   */
  recorded: { sessionId: string } | 'gone' | 'none'
}

/** The record file of one Claude tab, under the app's state folder. */
export function claudeSessionFile(stateDir: string, tabId: string): string {
  const sep = stateDir.includes('\\') ? '\\' : '/'
  return [stateDir.replace(/[/\\]+$/, ''), 'sessions', `${tabId}.json`].join(sep)
}

/**
 * Settings Claude Code loads on top of the user's own for an AlmaStudio tab:
 * a SessionStart hook that saves its input — the session id and transcript
 * path — to the file named by ALMASTUDIO_SESSION_FILE. It fires on startup,
 * on resume, after /clear and after compaction, so the file always names the
 * session the tab is on now, including one picked with /resume.
 */
export function claudeSessionSettings(): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'mkdir -p "$(dirname "$ALMASTUDIO_SESSION_FILE")" && cat > "$ALMASTUDIO_SESSION_FILE"',
            },
          ],
        },
      ],
    },
  })
}

/**
 * Codex's flags for each approval mode. Codex dropped the `untrusted` and
 * `on-failure` policies and `--full-auto`, so the modes are built from what
 * it still accepts: a sandbox, and approval on request or never.
 */
export const CODEX_APPROVAL_ARGS: Record<CodexApproval, string[]> = {
  config: [],
  // Reads freely; every edit and every command beyond reading is asked for.
  suggest: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
  // Works in the project on its own; asks to go beyond the sandbox.
  auto: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  'full-auto': ['--dangerously-bypass-approvals-and-sandbox'],
}

/** What the tab header shows as the thing it will run. */
export function harnessCommandLabel(kind: TerminalTab['kind'], settings: Settings): string {
  if (kind === 'shell') return settings.terminal.shell || '$SHELL'
  return settings.harness[kind].command
}

export function buildSpawnOptions(ctx: LaunchContext): SpawnOptions {
  const { tab, project, settings, cols, rows, resume, claudeSession } = ctx
  const cfg = settings.harness[tab.kind]
  const instructions = project?.instructions?.trim() ?? ''

  const env: Record<string, string> = {
    ALMASTUDIO_TAB_KIND: tab.kind,
    ALMASTUDIO_TAB_ID: tab.id,
  }
  if (project) {
    env.ALMASTUDIO_PROJECT = project.name
    env.ALMASTUDIO_PROJECT_ROOT = project.root
  }
  if (instructions) {
    // Always exported, whatever the delivery mode: it costs nothing and lets a
    // harness AlmaStudio knows nothing about pick the instructions up too.
    env.ALMASTUDIO_INSTRUCTIONS = instructions
  }

  // A plain terminal is just the user's shell; an empty program tells the
  // backend to start an interactive login shell directly.
  if (tab.kind === 'shell') {
    return {
      id: tab.id,
      cwd: tab.cwd,
      program: '',
      args: [],
      env,
      loginShell: true,
      shell: settings.terminal.shell || null,
      cols,
      rows,
    }
  }

  const resumeArgs = cfg.resumeArgs.length ? cfg.resumeArgs : cfg.args
  let args: string[]
  if (tab.kind === 'claude' && claudeSession) {
    env.ALMASTUDIO_SESSION_FILE = claudeSession.file
    const { recorded } = claudeSession
    if (!resume) args = [...cfg.args]
    else if (typeof recorded === 'object') args = ['--resume', recorded.sessionId]
    // Its own conversation is gone; continuing the folder's latest would take
    // over another tab's, so it starts afresh instead.
    else if (recorded === 'gone') args = [...cfg.args]
    else args = [...resumeArgs]
    args.push('--settings', claudeSessionSettings())
  } else {
    args = [...(resume ? resumeArgs : cfg.args)]
  }
  // `codex resume` takes the same flags, so a restored tab keeps its mode.
  if (tab.kind === 'codex') args.push(...CODEX_APPROVAL_ARGS[cfg.approval ?? 'config'])
  if (instructions && cfg.instructionsMode === 'flag' && cfg.instructionsFlag.trim()) {
    args.push(cfg.instructionsFlag.trim(), instructions)
  }

  return {
    id: tab.id,
    cwd: tab.cwd,
    program: cfg.command,
    args,
    env,
    loginShell: settings.terminal.loginShell,
    shell: settings.terminal.shell || null,
    cols,
    rows,
  }
}

/** Default tab title: the harness name, plus the folder when it is not the
 *  project root — tabs can be opened anywhere, so the folder is what
 *  distinguishes them. */
export function defaultTabTitle(cwd: string, projectRoot: string | undefined, label: string): string {
  if (projectRoot && sameFolder(cwd, projectRoot)) return label
  const folder = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd
  return `${label} · ${folder}`
}

export const sameFolder = (a: string, b: string) =>
  a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
