import { AppState, Platform } from 'react-native'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { create } from 'zustand'

import { ConnectError, RemoteConnection } from '@almastudio/protocol/src/client'
import { fromBase64Url } from '@almastudio/protocol/src/noise'
import { relayClientUrl } from '@almastudio/protocol/src/relay'
import type {
  AgentEventKind, Hello, PairingPayload, RemoteWorkspace,
} from '@almastudio/protocol'
import './random'
import { randomBytes } from './random'
import {
  DEFAULT_PREFS, deviceKeyPair, loadDesktops, loadPrefs, saveDesktops, savePrefs,
  type Desktop, type Prefs,
} from './storage'

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'offline'

/** Something an agent wants the user to see, shown until the tab is opened. */
export interface Attention {
  kind: AgentEventKind
  at: number
  message?: string
}

interface ConnectionState {
  booted: boolean
  desktops: Desktop[]
  prefs: Prefs
  activeId: string | null
  conn: RemoteConnection | null
  status: ConnStatus
  /** Why the last attempt failed, for the user. */
  error: string | null
  /** `lan` or `relay`: how the open connection is routed. */
  route: 'lan' | 'relay' | null
  workspace: RemoteWorkspace | null
  busy: Record<string, boolean>
  attention: Record<string, Attention>
  /** The project and terminal in front, per desktop. */
  projectId: string | null
  tabId: string | null

  boot: () => Promise<void>
  open: (desktopId: string) => void
  /** Opens a desktop at one tab, as a notification tapped asks for. */
  openAt: (desktopId: string, projectId: string, tabId: string) => void
  close: () => void
  pair: (payload: PairingPayload) => Promise<Desktop>
  forget: (desktopId: string) => Promise<void>
  setPrefs: (patch: Partial<Prefs>) => void
  selectProject: (projectId: string) => void
  selectTab: (tabId: string | null) => void
  clearAttention: (tabId: string) => void
}

function hello(token?: string): Hello {
  return {
    name: Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android'),
    platform: Platform.OS,
    app: Constants.expoConfig?.version ?? '0',
    ...(token ? { token } : {}),
  }
}

/** Every address a desktop may answer on: its LAN addresses, then the relay. */
export function candidateUrls(d: Pick<Desktop, 'id' | 'addresses' | 'relay'>): string[] {
  const urls = d.addresses.map((a) => `ws://${a}`)
  if (d.relay) urls.push(relayClientUrl(d.relay, fromBase64Url(d.id)))
  return urls
}

function describe(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.reason) {
      case 'not-paired': return 'This device is no longer paired with that computer. Pair it again.'
      case 'denied': return 'The computer did not allow this device.'
      case 'invalid-code': return 'The pairing code has expired. Show a new one on the computer.'
      case 'bad-key': return 'Another computer answered at that address.'
    }
    return 'Cannot reach the computer. Is AlmaStudio open, with the companion app allowed?'
  }
  return String((err as Error)?.message ?? err)
}

let retryTimer: ReturnType<typeof setTimeout> | undefined
/** A tab to show once the workspace arrives. */
let pendingSelection: { projectId: string; tabId: string } | null = null
let retryDelay = 1000
/** Bumped on every open/close so a stale attempt cannot install itself. */
let generation = 0

export const useConnection = create<ConnectionState>((set, get) => {
  const persistDesktops = (desktops: Desktop[]) => {
    set({ desktops })
    void saveDesktops(desktops).catch(() => {})
  }

  const updateDesktop = (id: string, patch: Partial<Desktop>) =>
    persistDesktops(get().desktops.map((d) => (d.id === id ? { ...d, ...patch } : d)))

  const scheduleRetry = () => {
    clearTimeout(retryTimer)
    if (!get().activeId || AppState.currentState !== 'active') return
    retryTimer = setTimeout(() => void connect(), retryDelay)
    retryDelay = Math.min(retryDelay * 2, 15_000)
  }

  const connect = async () => {
    const { activeId, desktops, conn } = get()
    const desktop = desktops.find((d) => d.id === activeId)
    if (!desktop || (conn && !conn.isClosed)) return
    const gen = ++generation
    set({ status: 'connecting' })
    try {
      const c = await RemoteConnection.connect({
        urls: candidateUrls(desktop),
        desktopKey: fromBase64Url(desktop.id),
        keyPair: await deviceKeyPair(),
        hello: hello(),
        random: randomBytes,
      })
      if (gen !== generation) {
        c.close()
        return
      }
      retryDelay = 1000
      install(desktop.id, c)
    } catch (err) {
      if (gen !== generation) return
      set({ status: 'offline', error: describe(err) })
      // A refusal will not change by retrying; an unreachable desktop may.
      if (!(err instanceof ConnectError && err.reason)) scheduleRetry()
    }
  }

  const install = (desktopId: string, c: RemoteConnection) => {
    set({
      conn: c,
      status: 'online',
      error: null,
      route: c.url.startsWith('ws://') ? 'lan' : 'relay',
    })
    c.on('workspace', (workspace) => adoptWorkspace(workspace))
    c.on('activity', ({ tabId, busy }) =>
      set((s) => ({ busy: { ...s.busy, [tabId]: busy } })),
    )
    c.on('agent', ({ tabId, kind, message }) => {
      if (get().tabId === tabId && AppState.currentState === 'active') return
      set((s) => ({ attention: { ...s.attention, [tabId]: { kind, message, at: Date.now() } } }))
    })
    c.onClose(() => {
      if (get().conn !== c) return
      set({ conn: null, status: 'offline', route: null })
      scheduleRetry()
    })
    void c.request('workspace.get', {}).then(({ workspace, busy }) => {
      if (workspace) adoptWorkspace(workspace)
      set({ busy: Object.fromEntries(busy.map((id) => [id, true])) })
    }).catch(() => {})
    // Its addresses may have changed since pairing; remember the new ones.
    void c.request('desktop.info', {}).then((info) => {
      updateDesktop(desktopId, {
        name: info.name || undefined,
        addresses: info.addresses.length ? info.addresses : get().desktops.find((d) => d.id === desktopId)?.addresses ?? [],
        relay: info.relay,
        lastConnectedAt: Date.now(),
      })
    }).catch(() => {})
  }

  /** Takes a new workspace, keeping the selection valid. */
  const adoptWorkspace = (workspace: RemoteWorkspace) => {
    let { projectId, tabId } = get()
    if (pendingSelection) {
      ;({ projectId, tabId } = pendingSelection)
      pendingSelection = null
    }
    const project =
      workspace.projects.find((p) => p.id === projectId) ??
      workspace.projects.find((p) => p.id === workspace.activeProjectId) ??
      workspace.projects[0] ?? null
    const tabs = project?.tabs ?? []
    const tab =
      tabs.find((t) => t.id === tabId) ??
      tabs.find((t) => t.id === project?.activeTabId) ??
      tabs[0] ?? null
    set({ workspace, projectId: project?.id ?? null, tabId: tab?.id ?? null })
  }

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      retryDelay = 1000
      void connect()
    } else if (state === 'background') {
      // iOS drops the socket soon anyway. Closing it now hands every terminal
      // this device had sized back to the desktop straight away.
      generation++
      clearTimeout(retryTimer)
      get().conn?.close()
      set({ conn: null, status: 'idle' })
    }
  })

  return {
    booted: false,
    desktops: [],
    prefs: DEFAULT_PREFS,
    activeId: null,
    conn: null,
    status: 'idle',
    error: null,
    route: null,
    workspace: null,
    busy: {},
    attention: {},
    projectId: null,
    tabId: null,

    boot: async () => {
      const [desktops, prefs] = await Promise.all([loadDesktops(), loadPrefs()])
      // Created now rather than on the first connection, which then is faster.
      await deviceKeyPair()
      set({ desktops, prefs, booted: true })
    },

    open: (desktopId) => {
      if (get().activeId === desktopId && get().conn) return
      get().close()
      set({ activeId: desktopId, workspace: null, projectId: null, tabId: null, busy: {}, error: null })
      retryDelay = 1000
      void connect()
    },

    openAt: (desktopId, projectId, tabId) => {
      const s = get()
      if (s.activeId === desktopId && s.workspace) {
        set({ projectId, tabId })
        s.clearAttention(tabId)
        if (!s.conn) void connect()
        return
      }
      pendingSelection = { projectId, tabId }
      s.open(desktopId)
    },

    close: () => {
      generation++
      clearTimeout(retryTimer)
      const c = get().conn
      set({ conn: null, status: 'idle', activeId: null, route: null })
      c?.close()
    },

    pair: async (payload) => {
      const desktop: Desktop = {
        id: payload.k,
        name: payload.n || 'Computer',
        addresses: payload.a,
        relay: payload.r,
        pairedAt: Date.now(),
      }
      let c: RemoteConnection
      try {
        c = await RemoteConnection.connect({
          urls: candidateUrls(desktop),
          desktopKey: fromBase64Url(desktop.id),
          keyPair: await deviceKeyPair(),
          hello: hello(payload.t),
          random: randomBytes,
          // Someone has to click Allow on the computer.
          handshakeTimeoutMs: 130_000,
        })
      } catch (err) {
        throw new Error(describe(err))
      }
      persistDesktops([...get().desktops.filter((d) => d.id !== desktop.id), desktop])
      get().close()
      generation++
      set({ activeId: desktop.id, workspace: null, projectId: null, tabId: null })
      install(desktop.id, c)
      return desktop
    },

    forget: async (desktopId) => {
      if (get().activeId === desktopId) get().close()
      persistDesktops(get().desktops.filter((d) => d.id !== desktopId))
    },

    setPrefs: (patch) => {
      const prefs = { ...get().prefs, ...patch }
      set({ prefs })
      void savePrefs(prefs).catch(() => {})
    },

    selectProject: (projectId) => {
      const project = get().workspace?.projects.find((p) => p.id === projectId)
      if (!project) return
      const tab = project.tabs.find((t) => t.id === project.activeTabId) ?? project.tabs[0] ?? null
      set({ projectId, tabId: tab?.id ?? null })
    },

    selectTab: (tabId) => {
      set({ tabId })
      if (tabId) get().clearAttention(tabId)
    },

    clearAttention: (tabId) =>
      set((s) => {
        if (!s.attention[tabId]) return s
        const attention = { ...s.attention }
        delete attention[tabId]
        return { attention }
      }),
  }
})

/** The connection in use, or an error to show when there is none. */
export function requireConn(): RemoteConnection {
  const c = useConnection.getState().conn
  if (!c || c.isClosed) throw new Error('Not connected')
  return c
}
