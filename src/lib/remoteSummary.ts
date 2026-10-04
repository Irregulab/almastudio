import { allTabIds, findLeaf } from './layout'
import { isTerminalTab, type HarnessKind, type WorkspaceState } from './types'
import type { RemoteProject, RemoteWorkspace } from '../../packages/protocol/src'

type Source = Pick<WorkspaceState, 'projects' | 'tabs' | 'workspaces' | 'activeProjectId'>

/**
 * What the companion app is told about the workspace: the projects and their
 * terminal tabs, in the desktop's order. Files, diffs and browsers stay on the
 * desktop; the app has its own pages for those.
 */
export function remoteSummary(
  state: Source,
  harnesses: HarnessKind[],
  label: (tabId: string) => string,
): RemoteWorkspace {
  const projects: RemoteProject[] = state.projects.map((p) => {
    const ws = state.workspaces[p.id]
    const tabs: RemoteProject['tabs'] = []
    for (const group of ws?.groups ?? []) {
      for (const id of allTabIds(group.layout)) {
        const tab = state.tabs[id]
        if (!tab || !isTerminalTab(tab)) continue
        tabs.push({
          id: tab.id,
          kind: tab.kind,
          title: label(tab.id),
          cwd: tab.cwd,
          status: tab.status,
          exitCode: tab.exitCode,
          groupId: group.id,
        })
      }
    }
    const group = ws?.groups.find((g) => g.id === ws.activeGroupId)
    const pane = group ? findLeaf(group.layout, group.activePaneId) : null
    const active = pane ? state.tabs[pane.tabId] : undefined
    return {
      id: p.id,
      name: p.name,
      icon: p.icon,
      color: p.color,
      category: p.category,
      root: p.root,
      pinnedRepos: p.pinnedRepos ?? [],
      tabs,
      activeTabId: active && isTerminalTab(active) ? active.id : null,
    }
  })
  return { activeProjectId: state.activeProjectId, projects, harnesses }
}
