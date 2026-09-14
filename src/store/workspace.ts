import { create } from 'zustand'
import {
  browserClose, ptyKill, scrollbackForget, scrollbackPrune, stateLoad, stateSave,
} from '../lib/ipc'
import { uid } from '../lib/id'
import { categoryOf } from '../lib/projectGroups'
import { useUi } from './ui'
import {
  allTabIds, containsNode, findLeaf, findLeafOfTab, firstPaneId, isLeaf, makeLeaf,
  removeLeaf, resizeSplit as resizeSplitIn, splitLeaf,
} from '../lib/layout'
import type {
  DiffSide, FileTab, HarnessKind, PanelState, Project, ProjectWorkspace, Tab, TabGroup,
  TerminalStatus, TerminalTab, WorkspaceState,
} from '../lib/types'
import { isTerminalTab } from '../lib/types'

/*
 * Vocabulary: a *tab* is what the strip shows — a `TabGroup`, one session or
 * several tiled side by side. A *session* is a terminal, file, diff or browser
 * (`Tab`, for historical reasons), and each pane shows exactly one.
 */

const STATE_KEY = 'workspace'
/**
 * 1: one tiling layout per project, each pane with its own strip of tabs.
 * 2: top-level tabs, each with a layout of its own; a pane shows one session.
 */
const STATE_VERSION = 2

const emptyWorkspace = (): ProjectWorkspace => ({
  groups: [],
  activeGroupId: null,
  panel: { open: false, view: 'changes', width: 380, pinnedRoot: null },
})

const initial: WorkspaceState = {
  version: STATE_VERSION,
  projects: [],
  tabs: {},
  workspaces: {},
  activeProjectId: null,
  sidebarOpen: true,
  sidebarWidth: 240,
  collapsedCategories: [],
}

type Dir = 'row' | 'col'

/** Opens a session split off an existing pane rather than as a tab of its own. */
interface SplitFrom {
  paneId: string
  dir: Dir
  before?: boolean
}

interface WorkspaceStore extends WorkspaceState {
  loaded: boolean
  hydrate: (s: WorkspaceState) => void

  // projects
  addProject: (p: Omit<Project, 'id' | 'createdAt' | 'lastOpenedAt'>) => Project
  updateProject: (id: string, patch: Partial<Project>) => void
  removeProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  /**
   * Moves a project with `moveItem` semantics. With `category` it also files
   * the project under it ('' for none): the section of the list it was dropped in.
   */
  reorderProjects: (from: number, to: number, category?: string) => void
  toggleCategory: (category: string) => void
  togglePinnedRepo: (projectId: string, path: string) => void

  // sessions
  addTerminalTab: (opts: {
    projectId: string; kind: HarnessKind; cwd: string; title?: string; splitFrom?: SplitFrom
  }) => TerminalTab
  openDiffTab: (opts: { projectId: string; root: string; path: string; side: DiffSide }) => Tab
  /** With `line` (and `column`, `length`), the file opens with that spot selected. */
  openFileTab: (opts: {
    projectId: string; root: string; path: string; line?: number; column?: number; length?: number
  }) => Tab
  openBrowserTab: (opts: { projectId: string; url?: string; splitFrom?: SplitFrom }) => Tab
  setTabUrl: (tabId: string, url: string) => void
  /** Closes one session: its pane goes, and its tab too when that was the last pane. */
  closeTab: (tabId: string) => void
  /** Brings a session forward: its tab in front, its pane focused. */
  focusTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  setTabCwd: (tabId: string, cwd: string) => void
  setTabStatus: (tabId: string, status: TerminalStatus, exitCode?: number) => void
  setTabResume: (tabId: string, resume: boolean) => void

  // tabs in the strip
  setActiveGroup: (groupId: string) => void
  closeGroup: (groupId: string) => void
  closeOtherGroups: (keepGroupId: string) => void
  /** Moves a tab to sit before whatever is at `to`, as the drop indicator reads. */
  moveGroup: (from: number, to: number) => void
  /** Puts a tab's focused session in a new pane split off `targetPaneId`, from a drop. */
  dropGroupIntoSplit: (groupId: string, targetPaneId: string, dir: Dir, before: boolean) => void

  // panes
  setActivePane: (paneId: string) => void
  /** Splits a pane with a new session of the same kind, in the same folder. */
  splitPane: (paneId: string, dir: Dir) => void
  /** Takes a pane out of its split into a tab of its own. */
  movePaneToNewGroup: (paneId: string) => void
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

/** Changes the active project's workspace; `fn` returns null for "nothing to do". */
function inActive(
  state: WorkspaceState,
  fn: (ws: ProjectWorkspace) => ProjectWorkspace | null,
): Partial<WorkspaceState> {
  const pid = state.activeProjectId
  const ws = pid ? state.workspaces[pid] : undefined
  if (!pid || !ws) return {}
  const next = fn(ws)
  return next ? { workspaces: { ...state.workspaces, [pid]: next } } : {}
}

const groupOfPane = (ws: ProjectWorkspace, paneId: string) =>
  ws.groups.find((g) => findLeaf(g.layout, paneId))

const groupOfTab = (ws: ProjectWorkspace, tabId: string) =>
  ws.groups.find((g) => findLeafOfTab(g.layout, tabId))

const updateGroup = (
  ws: ProjectWorkspace,
  id: string,
  fn: (g: TabGroup) => TabGroup,
): ProjectWorkspace => ({ ...ws, groups: ws.groups.map((g) => (g.id === id ? fn(g) : g)) })

/**
 * Shows a session: split off `from` when that pane exists, otherwise as a new
 * tab at the end of the strip. Either way it ends up in front, with focus.
 */
function place(ws: ProjectWorkspace, tabId: string, from?: SplitFrom): ProjectWorkspace {
  const leaf = makeLeaf(tabId)
  const host = from ? groupOfPane(ws, from.paneId) : undefined
  if (from && host) {
    return {
      ...updateGroup(ws, host.id, (g) => ({
        ...g,
        layout: splitLeaf(g.layout, from.paneId, from.dir, leaf, from.before),
        activePaneId: leaf.id,
      })),
      activeGroupId: host.id,
    }
  }
  const group: TabGroup = { id: uid('group'), layout: leaf, activePaneId: leaf.id }
  return { ...ws, groups: [...ws.groups, group], activeGroupId: group.id }
}

/**
 * Takes a session's pane away. Its tab goes too when that was its last pane,
 * and closing the tab in front brings its neighbour forward, as browsers do.
 */
function unplace(ws: ProjectWorkspace, tabId: string): ProjectWorkspace {
  const group = groupOfTab(ws, tabId)
  if (!group) return ws
  const layout = removeLeaf(group.layout, findLeafOfTab(group.layout, tabId)!.id)
  if (layout) {
    return updateGroup(ws, group.id, (g) => ({
      ...g,
      layout,
      activePaneId: findLeaf(layout, g.activePaneId) ? g.activePaneId : firstPaneId(layout),
    }))
  }
  const index = ws.groups.findIndex((g) => g.id === group.id)
  const groups = ws.groups.filter((g) => g.id !== group.id)
  return {
    ...ws,
    groups,
    activeGroupId:
      ws.activeGroupId === group.id
        ? (groups[Math.min(index, groups.length - 1)]?.id ?? null)
        : ws.activeGroupId,
  }
}

/**
 * Moves the item at `from` to sit before whatever is at index `to` in the
 * *current* order — the way a drop indicator drawn between two items reads.
 * Removing the item first shifts everything after it down by one, so a
 * forward move compensates; `to === list.length` means "put it last". Null
 * when nothing would change.
 */
function moveItem<T>(list: T[], from: number, to: number): T[] | null {
  if (from === to || from === to - 1) return null
  if (from < 0 || from >= list.length) return null
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(from < to ? to - 1 : to, next.length)), 0, moved)
  return next
}

/** Ends what a session holds outside the store: its process, browser view and saved output. */
function dispose(tab: Tab) {
  if (isTerminalTab(tab)) void ptyKill(tab.id).catch(() => {})
  if (tab.kind === 'browser') void browserClose(tab.id).catch(() => {})
  void scrollbackForget(tab.id).catch(() => {})
  useUi.getState().clearTabBusy(tab.id)
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
      const doomed = ws ? ws.groups.flatMap((g) => allTabIds(g.layout)) : []
      const tabs = { ...s.tabs }
      for (const t of doomed) {
        if (tabs[t]) dispose(tabs[t])
        delete tabs[t]
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

  reorderProjects: (from, to, category) =>
    set((s) => {
      const moved = s.projects[from]
      if (!moved) return {}
      let projects = moveItem(s.projects, from, to) ?? s.projects
      if (category !== undefined && categoryOf(moved) !== category) {
        projects = projects.map((p) =>
          p.id === moved.id ? { ...p, category: category || undefined } : p,
        )
      }
      return projects === s.projects ? {} : { projects }
    }),

  toggleCategory: (category) =>
    set((s) => ({
      collapsedCategories: s.collapsedCategories.includes(category)
        ? s.collapsedCategories.filter((c) => c !== category)
        : [...s.collapsedCategories, category],
    })),

  togglePinnedRepo: (projectId, path) =>
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p
        const pinned = p.pinnedRepos ?? []
        return {
          ...p,
          pinnedRepos: pinned.includes(path)
            ? pinned.filter((r) => r !== path)
            : [...pinned, path],
        }
      }),
    })),

  // ------------------------------------------------------------ sessions --
  addTerminalTab: ({ projectId, kind, cwd, title, splitFrom }) => {
    const tab: TerminalTab = {
      id: uid('tab'),
      projectId,
      kind,
      cwd,
      title: title ?? '',
      status: 'idle',
      resumeOnRestore: false,
      restored: false,
    }
    set((s) => ({
      tabs: { ...s.tabs, [tab.id]: tab },
      ...withWorkspace(s, projectId, (w) => place(w, tab.id, splitFrom)),
    }))
    return tab
  },

  openDiffTab: ({ projectId, root, path, side }) => {
    // Re-use an existing diff tab for the same file instead of stacking them up.
    const existing = Object.values(get().tabs).find(
      (t) => t.kind === 'diff' && t.projectId === projectId && t.path === path && t.root === root,
    )
    if (existing) {
      get().focusTab(existing.id)
      return existing
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
    set((s) => ({
      tabs: { ...s.tabs, [tab.id]: tab },
      ...withWorkspace(s, projectId, (w) => place(w, tab.id)),
    }))
    return tab
  },

  openFileTab: ({ projectId, root, path, line, column = 0, length = 0 }) => {
    const reveal = line ? { line, column, length, nonce: Date.now() } : undefined
    const existing = Object.values(get().tabs).find(
      (t): t is FileTab => t.kind === 'file' && t.projectId === projectId && t.path === path,
    )
    if (existing) {
      if (reveal) set((s) => ({ tabs: { ...s.tabs, [existing.id]: { ...existing, reveal } } }))
      get().focusTab(existing.id)
      return existing
    }
    const tab: Tab = {
      id: uid('tab'),
      projectId,
      kind: 'file',
      title: path.split('/').pop() ?? path,
      root,
      path,
      reveal,
    }
    set((s) => ({
      tabs: { ...s.tabs, [tab.id]: tab },
      ...withWorkspace(s, projectId, (w) => place(w, tab.id)),
    }))
    return tab
  },

  openBrowserTab: ({ projectId, url, splitFrom }) => {
    const tab: Tab = {
      id: uid('tab'),
      projectId,
      kind: 'browser',
      title: '',
      url: url ?? 'https://duckduckgo.com',
    }
    set((s) => ({
      tabs: { ...s.tabs, [tab.id]: tab },
      ...withWorkspace(s, projectId, (w) => place(w, tab.id, splitFrom)),
    }))
    return tab
  },

  setTabUrl: (tabId, url) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab || tab.kind !== 'browser' || tab.url === url) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, url } } }
    }),

  closeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      const tabs = { ...s.tabs }
      delete tabs[tabId]
      // Every close path funnels through here, so this is the one place that
      // has to end the process and drop its saved output.
      dispose(tab)
      const ws = s.workspaces[tab.projectId]
      if (!ws) return { tabs }
      return { tabs, workspaces: { ...s.workspaces, [tab.projectId]: unplace(ws, tabId) } }
    }),

  focusTab: (tabId) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      return withWorkspace(s, tab.projectId, (w) => {
        const group = groupOfTab(w, tabId)
        // A session without a pane — not expected, but cheap to mend — gets a tab.
        if (!group) return place(w, tabId)
        const leaf = findLeafOfTab(group.layout, tabId)!
        return {
          ...updateGroup(w, group.id, (g) => ({ ...g, activePaneId: leaf.id })),
          activeGroupId: group.id,
        }
      })
    }),

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
      // A session that is no longer running cannot be busy; the activity
      // monitor would otherwise leave the last transition standing.
      if (status !== 'running' && status !== 'starting') {
        useUi.getState().clearTabBusy(tabId)
      }
      return { tabs: { ...s.tabs, [tabId]: { ...tab, status, exitCode } } }
    }),

  setTabResume: (tabId, resume) =>
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab || !isTerminalTab(tab)) return {}
      return { tabs: { ...s.tabs, [tabId]: { ...tab, resumeOnRestore: resume } } }
    }),

  // ------------------------------------------------------- tabs in the strip --
  setActiveGroup: (groupId) =>
    set((s) =>
      inActive(s, (w) =>
        w.activeGroupId === groupId || !w.groups.some((g) => g.id === groupId)
          ? null
          : { ...w, activeGroupId: groupId },
      ),
    ),

  closeGroup: (groupId) => {
    for (const ws of Object.values(get().workspaces)) {
      const group = ws.groups.find((g) => g.id === groupId)
      if (!group) continue
      // The last session to go takes the tab with it.
      for (const id of allTabIds(group.layout)) get().closeTab(id)
      return
    }
  },

  closeOtherGroups: (keepGroupId) => {
    const s = get()
    const ws = s.activeProjectId ? s.workspaces[s.activeProjectId] : undefined
    for (const g of ws?.groups ?? []) if (g.id !== keepGroupId) get().closeGroup(g.id)
  },

  moveGroup: (from, to) =>
    set((s) =>
      inActive(s, (w) => {
        const groups = moveItem(w.groups, from, to)
        return groups ? { ...w, groups } : null
      }),
    ),

  dropGroupIntoSplit: (groupId, targetPaneId, dir, before) =>
    set((s) =>
      inActive(s, (w) => {
        const source = w.groups.find((g) => g.id === groupId)
        const moving = source ? findLeaf(source.layout, source.activePaneId) : null
        // Dropped onto its own pane: it is already where it was asked to go.
        if (!moving || moving.id === targetPaneId) return null
        const without = unplace(w, moving.tabId)
        // Leaving may have closed the very tab it was dropped into.
        if (!groupOfPane(without, targetPaneId)) return null
        return place(without, moving.tabId, { paneId: targetPaneId, dir, before })
      }),
    ),

  // --------------------------------------------------------------- panes --
  setActivePane: (paneId) =>
    set((s) =>
      inActive(s, (w) => {
        const group = groupOfPane(w, paneId)
        if (!group || (w.activeGroupId === group.id && group.activePaneId === paneId)) return null
        return {
          ...updateGroup(w, group.id, (g) => ({ ...g, activePaneId: paneId })),
          activeGroupId: group.id,
        }
      }),
    ),

  splitPane: (paneId, dir) => {
    const s = get()
    const pid = s.activeProjectId
    const ws = pid ? s.workspaces[pid] : undefined
    const leaf = ws?.groups.map((g) => findLeaf(g.layout, paneId)).find((l) => l) ?? null
    const tab = leaf ? s.tabs[leaf.tabId] : undefined
    if (!pid || !tab) return
    const splitFrom = { paneId, dir }
    // The new pane runs the same kind of session in the same folder. A file
    // or diff view has no session to repeat, so it gets a shell in its folder.
    if (isTerminalTab(tab)) {
      s.addTerminalTab({ projectId: pid, kind: tab.kind, cwd: tab.cwd, splitFrom })
    } else if (tab.kind === 'browser') {
      s.openBrowserTab({ projectId: pid, url: tab.url, splitFrom })
    } else {
      s.addTerminalTab({ projectId: pid, kind: 'shell', cwd: tab.root, splitFrom })
    }
  },

  movePaneToNewGroup: (paneId) =>
    set((s) =>
      inActive(s, (w) => {
        const group = groupOfPane(w, paneId)
        // A tab that is not split is already a tab of its own.
        if (!group || isLeaf(group.layout)) return null
        const { tabId } = findLeaf(group.layout, paneId)!
        return place(unplace(w, tabId), tabId)
      }),
    ),

  resizeSplit: (splitId, sizes) =>
    set((s) =>
      inActive(s, (w) => {
        const group = w.groups.find((g) => containsNode(g.layout, splitId))
        if (!group) return null
        return updateGroup(w, group.id, (g) => ({
          ...g,
          layout: resizeSplitIn(g.layout, splitId, sizes),
        }))
      }),
    ),

  // -------------------------------------------------------------- chrome --
  setPanel: (projectId, patch) =>
    set((s) => withWorkspace(s, projectId, (w) => ({ ...w, panel: { ...w.panel, ...patch } }))),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(420, w)) }),

  discardRestoredTabs: () =>
    set((s) => {
      const workspaces: Record<string, ProjectWorkspace> = {}
      for (const [id, ws] of Object.entries(s.workspaces)) {
        workspaces[id] = { ...ws, groups: [], activeGroupId: null }
      }
      void scrollbackPrune([]).catch(() => {})
      return { tabs: {}, workspaces }
    }),
}))

// ------------------------------------------------------------ persistence --

/** A pane as version 1 saved it: a strip of tabs rather than one session. */
interface V1Leaf {
  type: 'leaf'
  id: string
  tabIds?: string[]
  activeTabId?: string | null
}
type V1Node = V1Leaf | { type: 'split'; children: V1Node[] }

/**
 * Brings a saved project workspace to the current shape, dropping any pane
 * whose session no longer exists.
 *
 * Version 1 kept one layout per project, its panes each holding a strip of
 * tabs. Splits belonged to the project then, not to a tab, so there is no
 * faithful way to carry them over: every session becomes a tab of its own, in
 * the order it was shown, and the one that was in front stays in front.
 */
export function migrateWorkspace(raw: unknown, exists: (tabId: string) => boolean): ProjectWorkspace {
  const w = (raw ?? {}) as Record<string, unknown>
  const panel = (w.panel as PanelState | undefined) ?? emptyWorkspace().panel
  let ws: ProjectWorkspace

  if (Array.isArray(w.groups)) {
    ws = {
      groups: w.groups as TabGroup[],
      activeGroupId: (w.activeGroupId as string | null | undefined) ?? null,
      panel,
    }
  } else {
    const leaves = (n: V1Node | undefined): V1Leaf[] =>
      !n ? [] : n.type === 'leaf' ? [n] : n.children.flatMap(leaves)
    ws = { groups: [], activeGroupId: null, panel }
    let front: string | null = null
    for (const leaf of leaves(w.layout as V1Node | undefined)) {
      for (const tabId of leaf.tabIds ?? []) {
        ws = place(ws, tabId)
        if (leaf.id === w.activePaneId && leaf.activeTabId === tabId) front = ws.activeGroupId
      }
    }
    ws = { ...ws, activeGroupId: front }
  }

  for (const id of ws.groups.flatMap((g) => allTabIds(g.layout))) {
    if (!exists(id)) ws = unplace(ws, id)
  }
  if (!ws.groups.some((g) => g.id === ws.activeGroupId)) {
    ws = { ...ws, activeGroupId: ws.groups[0]?.id ?? null }
  }
  return ws
}

export async function loadWorkspace(): Promise<void> {
  try {
    const raw = await stateLoad(STATE_KEY)
    if (!raw) {
      useWorkspace.setState({ loaded: true })
      return
    }
    const parsed = JSON.parse(raw) as WorkspaceState
    // Processes never survive a restart, so every terminal tab comes back idle
    // regardless of how it was recorded when the app went away. Only tabs that
    // were actually alive are worth resuming: asking an agent to continue a
    // conversation that never started just makes it error out.
    const tabs: Record<string, Tab> = {}
    for (const [id, tab] of Object.entries(parsed.tabs ?? {})) {
      // 1.2.0 showed VS Code in a tab, from a server that is no longer started.
      if (tab.kind === 'browser' && 'vscodeFolder' in tab) continue
      tabs[id] = isTerminalTab(tab)
        ? {
            ...tab,
            resumeOnRestore: tab.status === 'running' || tab.status === 'starting',
            status: 'idle',
            exitCode: undefined,
            restored: true,
          }
        : tab
    }
    const workspaces: Record<string, ProjectWorkspace> = {}
    for (const [id, ws] of Object.entries(parsed.workspaces ?? {})) {
      workspaces[id] = migrateWorkspace(ws, (tabId) => tabId in tabs)
    }
    useWorkspace.getState().hydrate({
      version: STATE_VERSION,
      projects: parsed.projects ?? [],
      tabs,
      workspaces,
      activeProjectId: parsed.activeProjectId ?? parsed.projects?.[0]?.id ?? null,
      sidebarOpen: parsed.sidebarOpen ?? true,
      sidebarWidth: parsed.sidebarWidth ?? 240,
      collapsedCategories: parsed.collapsedCategories ?? [],
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
      state.sidebarWidth !== prev.sidebarWidth ||
      state.collapsedCategories !== prev.collapsedCategories
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
        collapsedCategories: s.collapsedCategories,
      }
      void stateSave(STATE_KEY, JSON.stringify(snapshot)).catch(() => {})
    }, 400)
  })
}
