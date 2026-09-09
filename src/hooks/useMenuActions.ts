import { useEffect } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { onMenuAction, stateDirPath } from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { checkForUpdates } from '../components/Updater'
import { findLeaf, findLeafOfTab, paneOrder } from '../lib/layout'
import type { HarnessKind } from '../lib/types'

const DOCS_URL = 'https://almaware.net/almastudio/docs'
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** Routes native menu items (and their accelerators) to store actions. */
export function useMenuActions() {
  useEffect(() => {
    let zoom = 1
    let unlisten: (() => void) | undefined

    const activePane = () => {
      const s = useWorkspace.getState()
      if (!s.activeProjectId) return null
      const ws = s.workspaces[s.activeProjectId]
      if (!ws) return null
      return findLeaf(ws.layout, ws.activePaneId) ?? null
    }

    const newTab = async (kind: HarnessKind, pick = false) => {
      const s = useWorkspace.getState()
      const project = s.projects.find((p) => p.id === s.activeProjectId)
      if (!project) return
      let cwd = project.root
      if (pick) {
        const picked = await openDialog({ directory: true, defaultPath: project.root })
        if (typeof picked !== 'string') return
        cwd = picked
      }
      s.addTerminalTab({ projectId: project.id, kind, cwd })
    }

    const cycleTab = (delta: number) => {
      const pane = activePane()
      if (!pane || pane.tabIds.length < 2) return
      const i = pane.tabIds.indexOf(pane.activeTabId ?? pane.tabIds[0])
      const next = (i + delta + pane.tabIds.length) % pane.tabIds.length
      useWorkspace.getState().setActiveTab(pane.id, pane.tabIds[next])
    }

    const setPanel = (patch: Parameters<
      ReturnType<typeof useWorkspace.getState>['setPanel']
    >[1]) => {
      const s = useWorkspace.getState()
      if (s.activeProjectId) s.setPanel(s.activeProjectId, patch)
    }

    const applyZoom = (delta: number | 'reset') => {
      if (delta === 'reset') zoom = 1
      else {
        const i = ZOOM_STEPS.indexOf(zoom)
        const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 3 : i) + delta))
        zoom = ZOOM_STEPS[next]
      }
      void getCurrentWebview().setZoom(zoom).catch(() => {})
    }

    void (async () => {
      unlisten = await onMenuAction((id) => {
        const s = useWorkspace.getState()
        switch (id) {
          case 'settings':
            useUi.getState().setSettingsOpen(true)
            break
          case 'new-project':
            useUi.getState().setNewProjectOpen(true)
            break
          case 'open-folder':
            void newTab(useSettings.getState().settings.defaultHarness, true)
            break
          case 'new-tab-claude': void newTab('claude'); break
          case 'new-tab-codex': void newTab('codex'); break
          case 'new-tab-terminal': void newTab('shell'); break
          case 'close-tab': {
            const pane = activePane()
            if (pane?.activeTabId) s.closeTab(pane.activeTabId)
            break
          }
          case 'close-pane': {
            const pane = activePane()
            if (pane) s.closePane(pane.id)
            break
          }
          case 'split-right': {
            const pane = activePane()
            if (pane) s.splitPane(pane.id, 'row')
            break
          }
          case 'split-down': {
            const pane = activePane()
            if (pane) s.splitPane(pane.id, 'col')
            break
          }
          case 'next-tab': cycleTab(1); break
          case 'prev-tab': cycleTab(-1); break
          case 'toggle-sidebar': s.toggleSidebar(); break
          case 'toggle-panel': {
            if (!s.activeProjectId) break
            const ws = s.workspaces[s.activeProjectId]
            setPanel({ open: !ws?.panel.open })
            break
          }
          case 'panel-changes': setPanel({ open: true, view: 'changes' }); break
          case 'panel-files': setPanel({ open: true, view: 'files' }); break
          case 'panel-git': setPanel({ open: true, view: 'git' }); break
          case 'zoom-in': applyZoom(1); break
          case 'zoom-out': applyZoom(-1); break
          case 'zoom-reset': applyZoom('reset'); break
          case 'check-updates':
            useUi.getState().setSettingsOpen(true)
            void checkForUpdates(false)
            break
          case 'docs': void openUrl(DOCS_URL).catch(() => {}); break
          case 'reveal-state':
            void stateDirPath().then((p) => revealItemInDir(p)).catch(() => {})
            break
        }
      })
    })()

    return () => unlisten?.()
  }, [])
}

export { findLeafOfTab, paneOrder }
