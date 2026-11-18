import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { platform } from '@tauri-apps/plugin-os'

import { SPRING_DELAY, useDrag, type SpringTarget } from '../lib/dragDrop'
import { quotePaths } from '../lib/shellQuote'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'

/**
 * Files dragged in from Finder or Explorer. Dropped on the Files panel they are
 * copied into the folder under the pointer (see FilesView). Dropped on a terminal — a shell
 * or a harness — their paths are typed into it the way a native terminal
 * does; dropped anywhere else they are ignored. Without this the webview's
 * default would navigate to the file, replacing the whole app with it.
 *
 * Held for a moment over a project in the sidebar or a tab in the strip, the
 * file brings it to the front, so a screenshot can reach a terminal that was
 * not on screen when the drag began.
 */
export function useFileDrop() {
  useEffect(() => {
    const os = platform()
    // The runtime reports the point in the webview's own units despite the
    // "physical" type: points on macOS and Linux, device pixels on Windows,
    // where devicePixelRatio already includes the page zoom.
    const toCss = ({ x, y }: { x: number; y: number }) => {
      const scale = os === 'windows' ? window.devicePixelRatio : useUi.getState().zoom
      return { x: x / scale, y: y / scale }
    }
    const terminalAt = (position: { x: number; y: number }) => {
      const { x, y } = toCss(position)
      return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-terminal-tab]') ?? null
    }
    /** The Files panel folder under the point: a folder row, or the row's parent. */
    const dropDirAt = (position: { x: number; y: number }) => {
      const { x, y } = toCss(position)
      const el = document.elementFromPoint(x, y)
      const dir = el?.closest<HTMLElement>('[data-drop-dir]')?.dataset.dropDir
      const root = el?.closest<HTMLElement>('[data-drop-root]')?.dataset.dropRoot
      return dir && root ? { dir, root } : null
    }
    /** The project or tab under the point, unless it is already in front. */
    const springAt = (position: { x: number; y: number }): SpringTarget | null => {
      const { x, y } = toCss(position)
      const el = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>('[data-spring-project], [data-spring-group]')
      if (!el) return null
      const ws = useWorkspace.getState()
      const project = el.dataset.springProject
      if (project) return project === ws.activeProjectId ? null : { kind: 'project', id: project }
      const group = el.dataset.springGroup!
      const active = ws.activeProjectId ? ws.workspaces[ws.activeProjectId]?.activeGroupId : undefined
      return group === active ? null : { kind: 'group', id: group }
    }

    let springTimer: ReturnType<typeof setTimeout> | undefined
    const spring = (target: SpringTarget | null) => {
      const current = useDrag.getState().springTarget
      if (current?.kind === target?.kind && current?.id === target?.id) return
      clearTimeout(springTimer)
      useDrag.setState({ springTarget: target })
      if (!target) return
      springTimer = setTimeout(() => {
        useDrag.setState({ springTarget: null })
        const ws = useWorkspace.getState()
        if (target.kind === 'project') ws.setActiveProject(target.id)
        else ws.setActiveGroup(target.id)
      }, SPRING_DELAY)
    }

    // Text or a link dragged from another app arrives here too, with no path.
    let carryingFiles = false
    let unlisten: (() => void) | undefined
    let disposed = false

    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        switch (payload.type) {
          case 'enter':
            carryingFiles = payload.paths.length > 0
            useDrag.setState({
              fileDropTab: carryingFiles ? terminalAt(payload.position)?.dataset.terminalTab ?? null : null,
              fileDropDir: carryingFiles ? dropDirAt(payload.position)?.dir ?? null : null,
            })
            spring(carryingFiles ? springAt(payload.position) : null)
            break
          case 'over':
            if (!carryingFiles) break
            useDrag.setState({
              fileDropTab: terminalAt(payload.position)?.dataset.terminalTab ?? null,
              fileDropDir: dropDirAt(payload.position)?.dir ?? null,
            })
            spring(springAt(payload.position))
            break
          case 'drop': {
            spring(null)
            useDrag.setState({ fileDropTab: null, fileDropDir: null })
            const into = payload.paths.length > 0 ? dropDirAt(payload.position) : null
            if (into) {
              window.dispatchEvent(
                new CustomEvent('almastudio:copy-in', { detail: { ...into, paths: payload.paths } }),
              )
              break
            }
            const term = terminalAt(payload.position)
            const tabId = term?.dataset.terminalTab
            if (!term || !tabId || payload.paths.length === 0) break
            const paneId = term.closest<HTMLElement>('[data-drop-pane]')?.dataset.paneId
            if (paneId) useWorkspace.getState().setActivePane(paneId)
            window.dispatchEvent(
              new CustomEvent('almastudio:paste', {
                detail: { tabId, text: quotePaths(payload.paths, os) },
              }),
            )
            break
          }
          case 'leave':
            spring(null)
            useDrag.setState({ fileDropTab: null, fileDropDir: null })
            break
        }
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })

    return () => {
      disposed = true
      clearTimeout(springTimer)
      unlisten?.()
    }
  }, [])
}
