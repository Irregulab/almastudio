// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AGENT_EVENT_HOOK, claudeSessionSettings, codexNotifyArgs } from './harness'

/** Runs a command the way Claude Code and Codex do: through `sh -c`. */
const sh = (args: string[], input: string, file: string) =>
  execFileSync('sh', args, { input, env: { ...process.env, ALMASTUDIO_EVENTS_FILE: file } })

describe.skipIf(process.platform === 'win32')('agent event hooks', () => {
  it('appends each Claude hook input as one line, and always succeeds', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'alma-')), 'events', 'tab.jsonl')
    sh(['-c', AGENT_EVENT_HOOK], '{\n  "hook_event_name": "Stop"\n}\n', file)
    sh(['-c', AGENT_EVENT_HOOK], '{"hook_event_name":"Notification","message":"hi"}', file)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).hook_event_name)).toEqual(['Stop', 'Notification'])
    // With nowhere to write it still exits 0, so Claude is never held up.
    expect(() => sh(['-c', AGENT_EVENT_HOOK], '{}', '')).not.toThrow()
  })

  it('registers the hook for Notification and Stop', () => {
    const hooks = JSON.parse(claudeSessionSettings()).hooks
    expect(hooks.Notification[0].hooks[0].command).toBe(AGENT_EVENT_HOOK)
    expect(hooks.Stop[0].hooks[0].command).toBe(AGENT_EVENT_HOOK)
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
