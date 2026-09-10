import { describe, expect, it } from 'vitest'
import { buildSpawnOptions, claudeSessionFile, claudeSessionSettings, type ClaudeSession } from './harness'
import { DEFAULT_SETTINGS } from '../store/settings'
import type { HarnessKind, TerminalTab } from './types'

const tab = (kind: HarnessKind): TerminalTab => ({
  id: 'tab-1',
  projectId: 'p',
  kind,
  cwd: '/work/app',
  title: '',
  status: 'idle',
  resumeOnRestore: true,
})

const launch = (kind: HarnessKind, resume: boolean, claudeSession?: ClaudeSession) =>
  buildSpawnOptions({
    tab: tab(kind),
    project: undefined,
    settings: DEFAULT_SETTINGS,
    cols: 80,
    rows: 24,
    resume,
    claudeSession,
  })

const file = '/state/sessions/tab-1.json'

describe('Claude Code sessions', () => {
  it('resumes the session the tab recorded, not the folder\'s latest', () => {
    const opts = launch('claude', true, { file, recorded: { sessionId: 'b8f2c1d0-aaaa' } })
    expect(opts.args.slice(0, 2)).toEqual(['--resume', 'b8f2c1d0-aaaa'])
    expect(opts.args).not.toContain('--continue')
  })

  it('starts afresh when the recorded session has nothing left to resume', () => {
    const opts = launch('claude', true, { file, recorded: 'gone' })
    expect(opts.args).not.toContain('--continue')
    expect(opts.args).not.toContain('--resume')
  })

  it('falls back to the configured resume arguments without a record', () => {
    const opts = launch('claude', true, { file, recorded: 'none' })
    expect(opts.args[0]).toBe('--continue')
  })

  it('records the session on every launch, through a hook it is told about', () => {
    const opts = launch('claude', false, { file, recorded: 'none' })
    expect(opts.env.ALMASTUDIO_SESSION_FILE).toBe(file)
    const at = opts.args.indexOf('--settings')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(opts.args[at + 1]).toBe(claudeSessionSettings())

    const hooks = JSON.parse(claudeSessionSettings()).hooks.SessionStart
    expect(hooks[0].hooks[0].command).toContain('> "$ALMASTUDIO_SESSION_FILE"')
  })

  it('leaves other harnesses alone', () => {
    const opts = launch('codex', true)
    expect(opts.args).toEqual(['resume', '--last'])
    expect(opts.env.ALMASTUDIO_SESSION_FILE).toBeUndefined()
  })

  it('keeps record files under the state folder', () => {
    expect(claudeSessionFile('/state/', 'tab-1')).toBe('/state/sessions/tab-1.json')
    expect(claudeSessionFile('C:\\state', 'tab-1')).toBe('C:\\state\\sessions\\tab-1.json')
  })
})
