/** Turns a tab plus the user's settings into a concrete process to spawn. */

import type { SpawnOptions } from './ipc'
import type { Project, Settings, TerminalTab } from './types'

export interface LaunchContext {
  tab: TerminalTab
  project: Project | undefined
  settings: Settings
  cols: number
  rows: number
  /** Use the harness's resume arguments instead of its normal ones. */
  resume: boolean
}

/** What the tab header shows as the thing it will run. */
export function harnessCommandLabel(kind: TerminalTab['kind'], settings: Settings): string {
  if (kind === 'shell') return settings.terminal.shell || '$SHELL'
  return settings.harness[kind].command
}

export function buildSpawnOptions(ctx: LaunchContext): SpawnOptions {
  const { tab, project, settings, cols, rows, resume } = ctx
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

  const args = [...(resume && cfg.resumeArgs.length ? cfg.resumeArgs : cfg.args)]
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
