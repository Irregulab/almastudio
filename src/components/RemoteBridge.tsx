import { useEffect } from 'react'
import { hostname } from '@tauri-apps/plugin-os'

import {
  onPairRequest, onPairRequestDone, onRemoteChanged, onRemoteCommand, ptyKill,
  remoteCommandResult, remoteConfigure, remotePublishState, remoteStatus, type RemoteCommand,
} from '../lib/ipc'
import { remoteSummary } from '../lib/remoteSummary'
import { isTerminalTab, type HarnessKind } from '../lib/types'
import { useInstalledHarnesses } from '../hooks/useInstalledHarnesses'
import { useRemote } from '../store/remote'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { sessionLabel } from './Pane'

const KINDS: HarnessKind[] = ['claude', 'codex', 'opencode', 'shell']
/** The size a terminal started from the app gets until it is shown here. */
const FALLBACK_SIZE = { cols: 100, rows: 32 }

/**
 * Connects the desktop UI to the companion server in the backend: keeps the
 * server in line with the settings, publishes the workspace to connected
 * devices, and carries out what they ask for. Renders nothing.
 */
export function RemoteBridge() {
  const remote = useSettings((s) => s.settings.remote)
  const harnesses = useInstalledHarnesses()

  // Start, stop or move the server whenever its settings change.
  useEffect(() => {
    let live = true
    void (async () => {
      // The network's domain ("Mac.fritz.box", "Mac.local") means nothing on
      // the phone; the machine's own name is what the user recognises.
      const host = (await hostname().catch(() => null)) ?? ''
      const name = host.split('.')[0] || 'AlmaStudio'
      const relay = remote.enabled && remote.relay && remote.relayUrl
        ? { url: remote.relayUrl }
        : null
      const status = await remoteConfigure(
        remote.enabled, remote.port, name, relay, remote.notify, remote.hideNames,
      )
      if (live) useRemote.getState().setStatus(status)
    })().catch(() => {})
    return () => {
      live = false
    }
  }, [remote.enabled, remote.port, remote.relay, remote.relayUrl, remote.notify, remote.hideNames])

  // Status for the settings page and the title bar.
  useEffect(() => {
    const refresh = () => void remoteStatus().then(useRemote.getState().setStatus).catch(() => {})
    const unlisten = onRemoteChanged(refresh)
    return () => void unlisten.then((un) => un())
  }, [])

  // Devices asking to pair wait for the user in a dialog.
  useEffect(() => {
    const a = onPairRequest((r) => useRemote.getState().addPairRequest(r))
    const b = onPairRequestDone((id) => useRemote.getState().removePairRequest(id))
    return () => {
      void a.then((un) => un())
      void b.then((un) => un())
    }
  }, [])

  // Publish the workspace whenever it changes, coalesced.
  useEffect(() => {
    if (!remote.enabled) return
    let timer: number | undefined
    const publish = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const state = useWorkspace.getState()
        const projectRoot = (pid: string) => state.projects.find((p) => p.id === pid)?.root
        const summary = remoteSummary(state, harnesses, (id) => {
          const tab = state.tabs[id]
          return tab ? sessionLabel(tab, projectRoot(tab.projectId)) : id
        })
        void remotePublishState(summary).catch(() => {})
      }, 150)
    }
    publish()
    const unsub = useWorkspace.subscribe((s, prev) => {
      if (
        s.projects !== prev.projects || s.tabs !== prev.tabs ||
        s.workspaces !== prev.workspaces || s.activeProjectId !== prev.activeProjectId
      ) {
        publish()
      }
    })
    return () => {
      unsub()
      window.clearTimeout(timer)
    }
  }, [remote.enabled, harnesses])

  // Carry out what connected devices ask for.
  useEffect(() => {
    const unlisten = onRemoteCommand((cmd) => {
      void runCommand(cmd, harnesses).then(
        (result) => remoteCommandResult(cmd.requestId, true, result ?? null, null),
        (err) => remoteCommandResult(cmd.requestId, false, null, String(err?.message ?? err)),
      )
    })
    return () => void unlisten.then((un) => un())
  }, [harnesses])

  return null
}

function sizeOf(params: Record<string, unknown>) {
  const cols = Number(params.cols)
  const rows = Number(params.rows)
  return cols > 0 && rows > 0 ? { cols, rows } : FALLBACK_SIZE
}

function terminalTab(tabId: unknown) {
  const tab = useWorkspace.getState().tabs[String(tabId)]
  if (!tab || !isTerminalTab(tab)) throw new Error('No such terminal tab')
  return tab
}

/** What a remote command does, in the same store actions the UI uses. */
export async function runCommand(
  cmd: RemoteCommand,
  harnesses: HarnessKind[],
): Promise<unknown> {
  const p = cmd.params ?? {}
  const ws = useWorkspace.getState()
  const remote = useRemote.getState()
  switch (cmd.method) {
    case 'tab.open': {
      const project = ws.projects.find((x) => x.id === p.projectId)
      if (!project) throw new Error('No such project')
      const kind = p.kind as HarnessKind
      if (!KINDS.includes(kind) || (kind !== 'shell' && !harnesses.includes(kind))) {
        throw new Error(`${kind} is not installed on this computer`)
      }
      const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : project.root
      const tab = ws.addTerminalTab({ projectId: project.id, kind, cwd })
      remote.requestStart(tab.id, { ...sizeOf(p), mode: 'open' })
      useUi.getState().mountProject(project.id)
      return { tabId: tab.id }
    }
    case 'tab.close': {
      const tab = terminalTab(p.tabId)
      ws.closeTab(tab.id)
      return null
    }
    case 'tab.start':
    case 'tab.restart': {
      const tab = terminalTab(p.tabId)
      remote.requestStart(tab.id, {
        ...sizeOf(p),
        mode: cmd.method === 'tab.start' ? 'start' : 'restart',
      })
      useUi.getState().mountProject(tab.projectId)
      return null
    }
    case 'tab.kill': {
      const tab = terminalTab(p.tabId)
      await ptyKill(tab.id)
      return null
    }
    default:
      throw new Error(`Unknown command ${cmd.method}`)
  }
}
