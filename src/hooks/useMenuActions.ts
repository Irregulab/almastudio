import { useEffect } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { platform } from '@tauri-apps/plugin-os'

import { onMenuAction, stateDirPath } from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { checkForUpdates } from '../components/Updater'
import { findLeaf } from '../lib/layout'
import type { HarnessKind } from '../lib/types'

const DOCS_URL = 'https://almaware.net/almastudio/docs'
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** Routes native menu items (and their accelerators) to store actions. */
export function useMenuActions() {
  useEffect(() => {
    let unlisten: (() => void) | undefined

    /** The active project's workspace, the tab in front, and its focused pane. */
    const front = () => {
      const s = useWorkspace.getState()
      const ws = s.activeProjectId ? s.workspaces[s.activeProjectId] : undefined
      const group = ws?.groups.find((g) => g.id === ws.activeGroupId)
      const pane = group ? findLeaf(group.layout, group.activePaneId) : null
      return { ws, group, pane }
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
      const { ws } = front()
      if (!ws || ws.groups.length < 2) return
      const i = Math.max(0, ws.groups.findIndex((g) => g.id === ws.activeGroupId))
      const next = ws.groups[(i + delta + ws.groups.length) % ws.groups.length]
      useWorkspace.getState().setActiveGroup(next.id)
    }

    const setPanel = (patch: Parameters<
      ReturnType<typeof useWorkspace.getState>['setPanel']
    >[1]) => {
      const s = useWorkspace.getState()
      if (s.activeProjectId) s.setPanel(s.activeProjectId, patch)
    }

    const applyZoom = (delta: number | 'reset') => {
      let zoom = useUi.getState().zoom
      if (delta === 'reset') zoom = 1
      else {
        const i = ZOOM_STEPS.indexOf(zoom)
        const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 3 : i) + delta))
        zoom = ZOOM_STEPS[next]
      }
      // Kept in the store: file drops need it to map native positions to CSS pixels.
      useUi.getState().setZoom(zoom)
      void getCurrentWebview().setZoom(zoom).catch(() => {})
    }

    // The native menu cannot bind every way of typing "+" (see menu.rs), so
    // the rest are caught here. On macOS the menu's key equivalent is the "+"
    // character, and ⌘= is added as browsers do; elsewhere the menu owns
    // Ctrl+=, and this adds the "+" character (Ctrl+Shift+= or the numpad).
    // WebKit gives the page first go at ⌘ shortcuts, so a key handled here
    // never reaches the menu as well: one press, one zoom step.
    const mac = platform() === 'macos'
    const onZoomKey = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey) return
      if (e.key === '+' || (mac && e.key === '=')) {
        e.preventDefault()
        e.stopPropagation()
        applyZoom(1)
      }
    }
    window.addEventListener('keydown', onZoomKey, true)

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
          case 'new-tab-opencode': void newTab('opencode'); break
          case 'new-tab-terminal': void newTab('shell'); break
          case 'new-tab-browser':
            if (s.activeProjectId) s.openBrowserTab({ projectId: s.activeProjectId })
            break
          // ⇧⌘W: the whole tab, every pane in it.
          case 'close-tab': {
            const { group } = front()
            if (group) s.closeGroup(group.id)
            break
          }
          // ⌘W: the focused pane — which is the whole tab when it is not split.
          case 'close-pane': {
            const { pane } = front()
            if (pane) s.closeTab(pane.tabId)
            break
          }
          case 'split-right': {
            const { pane } = front()
            if (pane) s.splitPane(pane.id, 'row')
            break
          }
          case 'split-down': {
            const { pane } = front()
            if (pane) s.splitPane(pane.id, 'col')
            break
          }
          case 'find':
            // The focused terminal picks this up; see TerminalView.
            window.dispatchEvent(new CustomEvent('almastudio:find'))
            break
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
          case 'panel-search': setPanel({ open: true, view: 'search' }); break
          case 'find-in-files':
            setPanel({ open: true, view: 'search' })
            // An already open Search view only needs the cursor; one opening
            // now takes it as it mounts.
            window.dispatchEvent(new CustomEvent('almastudio:search-focus'))
            break
          case 'zoom-in': applyZoom(1); break
          case 'zoom-out': applyZoom(-1); break
          case 'zoom-reset': applyZoom('reset'); break
          case 'check-updates':
            // Straight to the Updates page, where the check's result shows.
            useUi.getState().setSettingsOpen(true, 'updates')
            void checkForUpdates(false)
            break
          case 'docs': void openUrl(DOCS_URL).catch(() => {}); break
          case 'reveal-state':
            void stateDirPath().then((p) => revealItemInDir(p)).catch(() => {})
            break
        }
      })
    })()

    return () => {
      unlisten?.()
      window.removeEventListener('keydown', onZoomKey, true)
    }
  }, [])
}
