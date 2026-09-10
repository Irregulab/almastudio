import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { platform } from '@tauri-apps/plugin-os'

import { useDrag } from '../lib/dragDrop'
import { quotePaths } from '../lib/shellQuote'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'

/**
 * Files dragged in from Finder or Explorer. Dropped on a terminal — a shell
 * or a harness — their paths are typed into it the way a native terminal
 * does; dropped anywhere else they are ignored. Without this the webview's
 * default would navigate to the file, replacing the whole app with it.
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
            })
            break
          case 'over':
            if (!carryingFiles) break
            useDrag.setState({ fileDropTab: terminalAt(payload.position)?.dataset.terminalTab ?? null })
            break
          case 'drop': {
            useDrag.setState({ fileDropTab: null })
            const term = terminalAt(payload.position)
            const tabId = term?.dataset.terminalTab
            if (!term || !tabId || payload.paths.length === 0) break
            const paneId = term.closest<HTMLElement>('[data-drop-pane]')?.dataset.paneId
            if (paneId) useWorkspace.getState().setActivePane(paneId)
            window.dispatchEvent(
              new CustomEvent('almastudio:paste-paths', {
                detail: { tabId, text: quotePaths(payload.paths, os) },
              }),
            )
            break
          }
          case 'leave':
            useDrag.setState({ fileDropTab: null })
            break
        }
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
