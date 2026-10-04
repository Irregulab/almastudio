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
import type { RemoteWorkspace } from './index'

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
    const agentEvents: string[] = []
    c.on('agent', (e) => e.tabId === tabId && agentEvents.push(e.kind))
    await c.request('term.input', {
      tabId,
      data: `echo '{"hook_event_name":"Stop"}' >> "$ALMASTUDIO_EVENTS_FILE"\r`,
    })
    for (let i = 0; i < 40 && agentEvents.length === 0; i++) await sleep(100)
    expect(agentEvents).toEqual(['finished'])

    await c.request('term.release', { tabId })
    await sleep(200)
    expect(owners.at(-1)).toBe(false)

    await c.request('tab.close', { tabId })
    c.close()
  }, 200_000)
})
