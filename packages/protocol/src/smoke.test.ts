// @vitest-environment node
/**
 * End-to-end check against a running desktop in development, skipped unless
 * ALMASTUDIO_SMOKE_KEY is set to the desktop's public key (base64url, from
 * state/remote/identity.json) and the desktop was started with
 * ALMASTUDIO_REMOTE_DEV_TOKEN=devtoken. ALMASTUDIO_SMOKE_URL overrides the
 * address (default ws://127.0.0.1:47821); ALMASTUDIO_SMOKE_RELAY goes through
 * that relay instead. ALMASTUDIO_SMOKE_TOKEN pairs with a code from the QR
 * instead, which waits for someone to allow it on the desktop.
 */

import { describe, expect, it } from 'vitest'

import { RemoteConnection, utf8Decode } from './client'
import { fromBase64, fromBase64Url, generateKeyPair } from './noise'
import { relayClientUrl } from './relay'
import type { AgentAnswer, Events, RemoteWorkspace } from './index'

const KEY = process.env.ALMASTUDIO_SMOKE_KEY
const RELAY = process.env.ALMASTUDIO_SMOKE_RELAY
/** A code from the pairing QR: then someone has to allow the test on the desktop. */
const TOKEN = process.env.ALMASTUDIO_SMOKE_TOKEN
const URL = RELAY
  ? relayClientUrl(RELAY, fromBase64Url(KEY ?? ''))
  : process.env.ALMASTUDIO_SMOKE_URL ?? 'ws://127.0.0.1:47821'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!KEY)('desktop smoke', () => {
  it('pairs, opens a shell, types into it, owns its size and closes it', async () => {
    const keyPair = generateKeyPair()
    const desktopKey = fromBase64Url(KEY!)
    const conn = await RemoteConnection.connect({
      urls: [URL],
      desktopKey,
      keyPair,
      hello: { name: 'smoke', platform: 'test', app: '0', token: TOKEN ?? 'devtoken' },
      handshakeTimeoutMs: TOKEN ? 130_000 : 10_000,
    })
    expect(conn.welcome.ok).toBe(true)

    // Paired now: a second connection needs no code.
    conn.close()
    const c = await RemoteConnection.connect({
      urls: [URL],
      desktopKey,
      keyPair,
      hello: { name: 'smoke', platform: 'test', app: '0' },
    })

    let workspace: RemoteWorkspace | null = null
    for (let i = 0; i < 20 && !workspace; i++) {
      workspace = (await c.request('workspace.get', {})).workspace
      if (!workspace) await sleep(250)
    }
    expect(workspace!.projects.length).toBeGreaterThan(0)
    // The last project is one the desktop has not shown, so its terminal
    // starts hidden, at the size the app asked for.
    const project = workspace!.projects.at(-1)!

    const updates: RemoteWorkspace[] = []
    c.on('workspace', (w) => updates.push(w))
    const { tabId } = await c.request('tab.open', {
      projectId: project.id, kind: 'shell', cols: 50, rows: 20,
    })
    expect(tabId).toBeTruthy()

    let output = ''
    let attached = false
    c.on('term.data', (d) => {
      if (attached && d.tabId === tabId) output += utf8Decode(fromBase64(d.b64))
    })
    // The shell may still be starting; attach until it is live.
    for (let i = 0; i < 40; i++) {
      const snap = await c.request('term.attach', { tabId })
      if (snap.alive) {
        output += utf8Decode(fromBase64(snap.b64))
        attached = true
        break
      }
      await sleep(250)
    }
    expect(attached).toBe(true)
    expect(updates.some((w) => w.projects.some((p) => p.tabs.some((t) => t.id === tabId)))).toBe(true)

    const owners: boolean[] = []
    c.on('term.owner', (o) => o.tabId === tabId && owners.push(o.mine))
    await c.request('term.resize', { tabId, cols: 42, rows: 17 })
    await c.request('term.input', { tabId, data: 'stty size; echo smoke-$((40+2))\r' })
    for (let i = 0; i < 40 && !output.includes('smoke-42'); i++) await sleep(100)
    expect(output).toContain('smoke-42')
    expect(output).toContain('17 42')
    expect(owners).toContain(true)

    // An agent's turn ending reaches the app: the tab writes what a Stop
    // hook would to the events file every tab is given.
    const agentEvents: Array<Events['agent']> = []
    c.on('agent', (e) => e.tabId === tabId && agentEvents.push(e))
    const hook = (line: object) => c.request('term.input', {
      tabId,
      data: `echo '${JSON.stringify(line)}' >> "$ALMASTUDIO_EVENTS_FILE"\r`,
    })
    const nextEvent = async (n: number) => {
      for (let i = 0; i < 40 && agentEvents.length < n; i++) await sleep(100)
      expect(agentEvents.length).toBe(n)
      return agentEvents[n - 1]
    }
    await hook({ hook_event_name: 'Stop' })
    const stop = await nextEvent(1)
    expect(stop).toMatchObject({ kind: 'finished', answers: 'reply' })

    // Answered from its notification: a reply is typed, then Enter, once.
    const answer = async (e: Events['agent'], a: AgentAnswer, text?: string) =>
      (await c.request('agent.answer', { tabId, eventId: e.id!, answer: a, ...(text ? { text } : {}) })).outcome
    expect(await answer(stop, 'reply', 'echo replied-$((6*7))')).toBe('sent')
    for (let i = 0; i < 40 && !output.includes('replied-42'); i++) await sleep(100)
    expect(output).toContain('replied-42')
    expect(await answer(stop, 'reply', 'echo replied-$((6*7))')).toBe('already')
    expect(await answer(stop, 'allow')).toBe('stale')

    // A permission prompt says what it is for, from the request before it,
    // and takes allow or deny — not a message, which would land in it.
    await hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hi' } })
    await hook({
      hook_event_name: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    })
    const prompt = await nextEvent(2)
    expect(prompt).toMatchObject({ kind: 'permission', answers: 'decision', message: 'Bash: echo hi' })
    expect(await answer(prompt, 'reply', 'no')).toBe('asking')
    expect(await answer(prompt, 'allow')).toBe('sent')
    expect(await answer(prompt, 'allow')).toBe('already')
    expect(await answer(prompt, 'deny')).toBe('stale')

    // Typed into since: refused rather than typed into what is there now.
    await hook({ hook_event_name: 'Stop' })
    const later = await nextEvent(3)
    await c.request('term.input', { tabId, data: ':' })
    expect(await answer(later, 'reply', 'echo too-late')).toBe('stale')
    await c.request('term.input', { tabId, data: '\r' })

    await c.request('term.release', { tabId })
    await sleep(200)
    expect(owners.at(-1)).toBe(false)

    await c.request('tab.close', { tabId })
    for (let i = 0; i < 20 && (await answer(later, 'reply', 'x')) !== 'gone'; i++) await sleep(100)
    expect(await answer(later, 'reply', 'x')).toBe('gone')
    c.close()
  }, 200_000)
})
