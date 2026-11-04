// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AGENT_EVENT_HOOK, SESSION_RECORD_HOOK, claudeSessionSettings, codexNotifyArgs } from './harness'

/**
 * Runs a command the way Claude Code and Codex do: through `sh -c`, as the
 * tab's own session even when the tests run inside a background one.
 */
const sh = (args: string[], input: string, file: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ALMASTUDIO_EVENTS_FILE: file }
  delete env.CLAUDE_CODE_SESSION_KIND
  return execFileSync('sh', args, { input, env })
}

describe.skipIf(process.platform === 'win32')('session record hook', () => {
  const record = (input: string, file: string, kind?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ALMASTUDIO_SESSION_FILE: file }
    delete env.CLAUDE_CODE_SESSION_KIND
    if (kind) env.CLAUDE_CODE_SESSION_KIND = kind
    execFileSync('sh', ['-c', SESSION_RECORD_HOOK], { input, env })
  }

  it('records the tab\'s own session, and not a background one started from it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'alma-')), 'sessions', 'tab.json')
    record('{"session_id":"tab-session","source":"startup"}', file)
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe('tab-session')

    // Claude Code's daemon starts these with the tab's environment and settings.
    record('{"session_id":"bg-session","source":"startup"}', file, 'bg')
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe('tab-session')

    record('{"session_id":"after-clear","source":"clear"}', file, 'interactive')
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe('after-clear')
  })

  it('is the SessionStart hook', () => {
    const hooks = JSON.parse(claudeSessionSettings()).hooks
    expect(hooks.SessionStart[0].hooks[0].command).toBe(SESSION_RECORD_HOOK)
  })
})

describe.skipIf(process.platform === 'win32')('agent event hooks', () => {
  it('appends each Claude hook input as one line, and always succeeds', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'alma-')), 'events', 'tab.jsonl')
    sh(['-c', AGENT_EVENT_HOOK], '{\n  "hook_event_name": "Stop"\n}\n', file)
    sh(['-c', AGENT_EVENT_HOOK], '{"hook_event_name":"Notification","message":"hi"}', file)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).hook_event_name)).toEqual(['Stop', 'Notification'])
    // It prints nothing: as a PermissionRequest hook that decides nothing,
    // so Claude still asks.
    expect(sh(['-c', AGENT_EVENT_HOOK], '{"hook_event_name":"PermissionRequest"}', file).length).toBe(0)
    // With nowhere to write it still exits 0, so Claude is never held up.
    expect(() => sh(['-c', AGENT_EVENT_HOOK], '{}', '')).not.toThrow()
  })

  it('leaves out the events of a background session started from the tab', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'alma-')), 'events', 'tab.jsonl')
    const env = (kind?: string) => {
      const e: NodeJS.ProcessEnv = { ...process.env, ALMASTUDIO_EVENTS_FILE: file }
      delete e.CLAUDE_CODE_SESSION_KIND
      if (kind) e.CLAUDE_CODE_SESSION_KIND = kind
      return e
    }
    const run = (input: string, kind?: string) =>
      execFileSync('sh', ['-c', AGENT_EVENT_HOOK], { input, env: env(kind) })
    run('{"hook_event_name":"Stop","session_id":"tab"}')
    expect(run('{"hook_event_name":"PermissionRequest","session_id":"bg"}', 'bg').length).toBe(0)
    run('{"hook_event_name":"Notification","session_id":"tab"}', 'interactive')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).session_id)).toEqual(['tab', 'tab'])
  })

  it('registers the hook for Notification, Stop and PermissionRequest', () => {
    const hooks = JSON.parse(claudeSessionSettings()).hooks
    expect(hooks.Notification[0].hooks[0].command).toBe(AGENT_EVENT_HOOK)
    expect(hooks.Stop[0].hooks[0].command).toBe(AGENT_EVENT_HOOK)
    expect(hooks.PermissionRequest[0].hooks[0].command).toBe(AGENT_EVENT_HOOK)
  })

  it('gives Codex a notify program that writes its event as a line', () => {
    const [flag, value] = codexNotifyArgs()
    expect(flag).toBe('-c')
    // `notify=[...]` is TOML; this array is also valid JSON.
    const argv = JSON.parse(value.slice('notify='.length)) as string[]
    const file = join(mkdtempSync(join(tmpdir(), 'alma-')), 'tab.jsonl')
    const event = '{"type":"agent-turn-complete","last-assistant-message":"done"}'
    sh([...argv.slice(1), event], '', file)
    expect(JSON.parse(readFileSync(file, 'utf8').trim()).type).toBe('agent-turn-complete')
  })
})
