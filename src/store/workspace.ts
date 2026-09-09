import { create } from 'zustand'
import { ptyKill, scrollbackForget, scrollbackPrune, stateLoad, stateSave } from '../lib/ipc'
import { uid } from '../lib/id'
import {
  allTabIds, findLeaf, findLeafOfTab, makeLeaf, moveTab as moveTabIn,
  removeTab as removeTabFrom, resizeSplit as resizeSplitIn, splitLeaf, updateLeaf,
} from '../lib/layout'
import type {
  DiffSide, HarnessKind, LayoutNode, Project, ProjectWorkspace,
  Tab, TerminalStatus, TerminalTab, WorkspaceState,
} from '../lib/types'
import { isTerminalTab } from '../lib/types'

const STATE_KEY = 'workspace'
const STATE_VERSION = 1

const emptyWorkspace = (): ProjectWorkspace => {
  const leaf = makeLeaf()
  return {
    layout: leaf,
    activePaneId: leaf.id,
    panel: { open: false, view: 'changes', width: 380, pinnedRoot: null },
  }
}

const initial: WorkspaceState = {
  version: STATE_VERSION,
  projects: [],
  tabs: {},
  workspaces: {},
  activeProjectId: null,
  sidebarOpen: true,
  sidebarWidth: 240,
}

interface WorkspaceStore extends WorkspaceState {
  loaded: boolean
  hydrate: (s: WorkspaceState) => void

  // projects
  addProject: (p: Omit<Project, 'id' | 'createdAt' | 'lastOpenedAt'>) => Project
  updateProject: (id: string, patch: Partial<Project>) => void
  removeProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  reorderProjects: (from: number, to: number) => void

  // tabs
  addTerminalTab: (opts: {
    projectId: string; kind: HarnessKind; cwd: string; paneId?: string; title?: string
  }) => TerminalTab
  openDiffTab: (opts: {
    projectId: string; root: string; path: string; side: DiffSide; paneId?: string
  }) => Tab
  openFileTab: (opts: {
    projectId: string; root: string; path: string; paneId?: string
  }) => Tab
  closeTab: (tabId: string) => void
  closeOtherTabs: (paneId: string, keepTabId: string) => void
  renameTab: (tabId: string, title: string) => void
  setTabCwd: (tabId: string, cwd: string) => void
  setTabStatus: (tabId: string, status: TerminalStatus, exitCode?: number) => void
  setTabResume: (tabId: string, resume: boolean) => void

  // layout
  setActiveTab: (paneId: string, tabId: string) => void
  setActivePane: (paneId: string) => void
  splitPane: (paneId: string, dir: 'row' | 'col', tabId?: string) => void
  closePane: (paneId: string) => void
  moveTab: (tabId: string, targetPaneId: string, index: number) => void
  resizeSplit: (splitId: string, sizes: number[]) => void

  // chrome
  setPanel: (projectId: string, patch: Partial<ProjectWorkspace['panel']>) => void
  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  /** Drops restored tabs when the user has turned tab restore off. */
  discardRestoredTabs: () => void
}

/** Applies a change to one project's workspace, creating it on first use. */
function withWorkspace(
  state: WorkspaceState,
  projectId: string,
  fn: (ws: ProjectWorkspace) => ProjectWorkspace,
): Partial<WorkspaceState> {
  const ws = state.workspaces[projectId] ?? emptyWorkspace()
  return { workspaces: { ...state.workspaces, [projectId]: fn(ws) } }
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  ...initial,
  loaded: false,
  hydrate: (s) => set({ ...s, loaded: true }),

  // ------------------------------------------------------------ projects --
  addProject: (p) => {
    const project: Project = {
      ...p,
      id: uid('proj'),
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    }
    set((s) => ({
      projects: [...s.projects, project],
      workspaces: { ...s.workspaces, [project.id]: emptyWorkspace() },
      activeProjectId: project.id,
    }))
    return project
  },

  updateProject: (id, patch) =>
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  removeProject: (id) =>
    set((s) => {
      const ws = s.workspaces[id]
      const doomed = ws ? allTabIds(ws.layout) : []
      const tabs = { ...s.tabs }
      for (const t of doomed) {
        if (isTerminalTab(tabs[t])) void ptyKill(t).catch(() => {})
        delete tabs[t]
        void scrollbackForget(t).catch(() => {})
      }
      const workspaces = { ...s.workspaces }
      delete workspaces[id]
      const projects = s.projects.filter((p) => p.id !== id)
      return {
        projects,
        tabs,
        workspaces,
        activeProjectId:
          s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
      }
    }),

  setActiveProject: (id) =>
    set((s) => ({
      activeProjectId: id,
      projects: id
        ? s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: Date.now() } : p))
        : s.projects,
      workspaces:
        id && !s.workspaces[id]
          ? { ...s.workspaces, [id]: emptyWorkspace() }
          : s.workspaces,
    })),

  reorderProjects: (from, to) =>
    set((s) => {
      const next = [...s.projects]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { projects: next }
    }),

  // ---------------------------------------------------------------- tabs --
  addTerminalTab: ({ projectId, kind, cwd, paneId, title }) => {
    const tab: TerminalTab = {
      id: uid('tab'),
      projectId,
      kind,
      cwd,
      title: title ?? '',
      status: 'idle',
      resumeOnRestore: false,
    }
    set((s) => {
      const ws = s.workspaces[projectId] ?? emptyWorkspace()
      const target = paneId ?? ws.activePaneId
      const pane = findLeaf(ws.layout, target)
      const landing = pane ? target : ws.activePaneId
      return {
        tabs: { ...s.tabs, [tab.id]: tab },
        ...withWorkspace(s, projectId, (w) => ({
          ...w,
          activePaneId: landing,
          layout: updateLeaf(w.layout, landing, (l) => ({
            ...l,
            tabIds: [...l.tabIds, tab.id],
            activeTabId: tab.id,
          })),
        })),
      }
    })
    return tab
  },

  openDiffTab: ({ projectId, root, path, side, paneId }) => {
    // Re-use an existing diff tab for the same file instead of stacking them up.
    const existing = Object.values(get().tabs).find(
      (t) => t.kind === 'diff' && t.projectId === projectId && t.path === path && t.root === root,
    )
    if (existing) {
      const ws = get().workspaces[projectId]
      const leaf = ws ? findLeafOfTab(ws.layout, existing.id) : null
      if (leaf) {
        get().setActiveTab(leaf.id, existing.id)
        return existing
      }
    }

    const tab: Tab = {
      id: uid('tab'),
      projectId,
      kind: 'diff',
      title: path.split('/').pop() ?? path,
      root,
      path,
      side,
    }
    set((s) => {
      const ws = s.workspaces[projectId] ?? emptyWorkspace()
      const landing = paneId && findLeaf(ws.layout, paneId) ? paneId : ws.activePaneId
      return {
        tabs: { ...s.tabs, [tab.id]: tab },
        ...withWorkspace(s, projectId, (w) => ({
          ...w,
          activePaneId: landing,
          layout: updateLeaf(w.layout, landing, (l) => ({
            ...l,
            tabIds: [...l.tabIds, tab.id],
            activeTabId: tab.id,
          })),
        })),
      }
    })
    return tab
  },

  openFileTab: ({ projectId, root, path, paneId }) => {
    const existing = Object.values(get().tabs).find(
      (t) => t.kind === 'file' && t.projectId === projectId && t.path === path,
    )
    if (existing) {
      const ws = get().workspaces[projectId]
      const leaf = ws ? findLeafOfTab(ws.layout, existing.id) : null
      if (leaf) {
        get().setActiveTab(leaf.id, existing.id)
        return existing
      }
    }
    const tab: Tab = {
      id: uid('tab'),
      projectId,
      kind: 'file',
      title: path.split('/').pop() ?? path,
      root,
      path,
    }
    set((s) => {
      const ws = s.workspaces[projectId] ?? emptyWorkspace()
      const landing = paneId && findLeaf(ws.layout, paneId) ? paneId : ws.activePaneId
      return {
        tabs: { ...s.tabs, [tab.id]: tab },
        ...withWorkspace(s, projectId, (w) => ({
          ...w,
          activePaneId: landing,
          layout: updateLeaf(w.layout, landing, (l) => ({
            ...l,
            tabIds: [...l.tabIds, tab.id],
            activeTabId: tab.id,
          })),
        })),
      }
    })
    return tab
  },

  closeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      const tabs = { ...s.tabs }
      delete tabs[tabId]
      // Every close path funnels through here, so this is the one place that
      // has to end the process and drop its saved output.
      if (isTerminalTab(tab)) void ptyKill(tabId).catch(() => {})
      void scrollbackForget(tabId).catch(() => {})

      const ws = s.workspaces[tab.projectId]
      if (!ws) return { tabs }
      const { root, removedPaneId } = removeTabFrom(ws.layout, tabId)
      if (!root) return { tabs }
      return {
        tabs,
        workspaces: {
          ...s.workspaces,
          [tab.projectId]: {
            ...ws,
            layout: root,
            activePaneId:
              removedPaneId === ws.activePaneId
                ? (findLeaf(root, ws.activePaneId)?.id ?? firstPaneId(root))
                : ws.activePaneId,
          },
        },
      }
    }),

  closeOtherTabs: (paneId, keepTabId) => {
    const s = get()
    const projectId = s.tabs[keepTabId]?.projectId
    if (!projectId) return
    const ws = s.workspaces[projectId]
    const pane = ws ? findLeaf(ws.layout, paneId) : null
    if (!pane) return
    for (const id of pane.tabIds) if (id !== keepTabId) get().closeTab(id)
  },

  renameTab: (tabId, title) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, title, renamed: true } } }
    }),

  setTabCwd: (tabId, cwd) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab || !isTerminalTab(tab)) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, cwd } } }
    }),

  setTabStatus: (tabId, status, exitCode) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab || !isTerminalTab(tab)) return {}
      if (tab.status === status && tab.exitCode === exitCode) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, status, exitCode } } }
    }),

  setTabResume: (tabId, resume) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab || !isTerminalTab(tab)) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, resumeOnRestore: resume } } }
    }),

  // -------------------------------------------------------------- layout --
  setActiveTab: (paneId, tabId) =>
    set((s) => {
      const projectId = s.tabs[tabId]?.projectId ?? s.activeProjectId
      if (!projectId) return {}
      return withWorkspace(s, projectId, (w) => ({
        ...w,
        activePaneId: paneId,
        layout: updateLeaf(w.layout, paneId, (l) => ({ ...l, activeTabId: tabId })),
      }))
    }),

  setActivePane: (paneId) =>
    set((s) => {
      if (!s.activeProjectId) return {}
      return withWorkspace(s, s.activeProjectId, (w) => ({ ...w, activePaneId: paneId }))
    }),

  splitPane: (paneId, dir, tabId) =>
    set((s) => {
      const projectId = s.activeProjectId
      if (!projectId) return {}
      const ws = s.workspaces[projectId]
      if (!ws) return {}

      // Splitting with a tab moves that tab into the new pane; splitting
      // without one leaves an empty pane ready for the next tab.
      const newLeaf = makeLeaf(tabId ? [tabId] : [])
      let layout = splitLeaf(ws.layout, paneId, dir, newLeaf)
      if (tabId) {
        const source = findLeaf(layout, paneId)
        if (source?.tabIds.includes(tabId)) {
          const remaining = source.tabIds.filter((id) => id !== tabId)
          layout = updateLeaf(layout, paneId, (l) => ({
            ...l,
            tabIds: remaining,
            activeTabId: l.activeTabId === tabId ? (remaining[0] ?? null) : l.activeTabId,
          }))
        }
      }
      return {
        workspaces: {
          ...s.workspaces,
          [projectId]: { ...ws, layout, activePaneId: newLeaf.id },
        },
      }
    }),

  closePane: (paneId) => {
    const s = get()
    const projectId = s.activeProjectId
    if (!projectId) return
    const ws = s.workspaces[projectId]
    const pane = ws ? findLeaf(ws.layout, paneId) : null
    if (!pane) return
    for (const id of [...pane.tabIds]) get().closeTab(id)
  },

  moveTab: (tabId, targetPaneId, index) =>
    set((s) => {
      const projectId = s.tabs[tabId]?.projectId
      if (!projectId) return {}
      return withWorkspace(s, projectId, (w) => ({
        ...w,
        layout: moveTabIn(w.layout, tabId, targetPaneId, index),
        activePaneId: targetPaneId,
      }))
    }),

  resizeSplit: (splitId, sizes) =>
    set((s) => {
      if (!s.activeProjectId) return {}
      return withWorkspace(s, s.activeProjectId, (w) => ({
        ...w,
        layout: resizeSplitIn(w.layout, splitId, sizes),
      }))
    }),

  // -------------------------------------------------------------- chrome --
  setPanel: (projectId, patch) =>
    set((s) => withWorkspace(s, projectId, (w) => ({ ...w, panel: { ...w.panel, ...patch } }))),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(420, w)) }),

  discardRestoredTabs: () =>
    set((s) => {
      const workspaces: Record<string, ProjectWorkspace> = {}
      for (const [id, ws] of Object.entries(s.workspaces)) {
        const leaf = makeLeaf()
        workspaces[id] = { ...ws, layout: leaf, activePaneId: leaf.id }
      }
      void scrollbackPrune([]).catch(() => {})
      return { tabs: {}, workspaces }
    }),
}))

function firstPaneId(node: LayoutNode): string {
  return node.type === 'leaf' ? node.id : firstPaneId(node.children[0])
}

// ------------------------------------------------------------ persistence --

export async function loadWorkspace(): Promise<void> {
  try {
    const raw = await stateLoad(STATE_KEY)
    if (!raw) {
      useWorkspace.setState({ loaded: true })
      return
    }
    const parsed = JSON.parse(raw) as WorkspaceState
    // Processes never survive a restart, so every terminal tab comes back idle
    // regardless of how it was recorded when the app went away.
    const tabs: Record<string, Tab> = {}
    for (const [id, tab] of Object.entries(parsed.tabs ?? {})) {
      tabs[id] = isTerminalTab(tab)
        ? { ...tab, status: 'idle', exitCode: undefined, resumeOnRestore: true }
        : tab
    }
    useWorkspace.getState().hydrate({
      version: STATE_VERSION,
      projects: parsed.projects ?? [],
      tabs,
      workspaces: parsed.workspaces ?? {},
      activeProjectId: parsed.activeProjectId ?? parsed.projects?.[0]?.id ?? null,
      sidebarOpen: parsed.sidebarOpen ?? true,
      sidebarWidth: parsed.sidebarWidth ?? 240,
    })
    // Drop scrollback belonging to tabs that no longer exist.
    void scrollbackPrune(Object.keys(tabs)).catch(() => {})
  } catch {
    useWorkspace.setState({ loaded: true })
  }
}

let saveTimer: number | undefined

/**
 * Persists on a short debounce rather than at exit: a power cut or a `kill -9`
 * gives us no chance to run shutdown code, and losing the last few hundred
 * milliseconds of layout changes is the worst case we accept.
 */
export function startWorkspacePersistence() {
  useWorkspace.subscribe((state, prev) => {
    if (!state.loaded) return
    const changed =
      state.projects !== prev.projects ||
      state.tabs !== prev.tabs ||
      state.workspaces !== prev.workspaces ||
      state.activeProjectId !== prev.activeProjectId ||
      state.sidebarOpen !== prev.sidebarOpen ||
      state.sidebarWidth !== prev.sidebarWidth
    if (!changed) return

    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = useWorkspace.getState()
      const snapshot: WorkspaceState = {
        version: STATE_VERSION,
        projects: s.projects,
        tabs: s.tabs,
        workspaces: s.workspaces,
        activeProjectId: s.activeProjectId,
        sidebarOpen: s.sidebarOpen,
        sidebarWidth: s.sidebarWidth,
      }
      void stateSave(STATE_KEY, JSON.stringify(snapshot)).catch(() => {})
    }, 400)
  })
}
