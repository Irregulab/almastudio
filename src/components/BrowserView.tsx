import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Home, RotateCw } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import {
  browserCommand, browserOpen, browserSetBounds, browserSetVisible,
  onBrowserNavigated, vscodeWebUrl, type Bounds,
} from '../lib/ipc'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import type { BrowserTab } from '../lib/types'

/**
 * A browser tab is a native child webview positioned over this component's
 * placeholder. Because that webview is not part of the HTML stacking order it
 * would cover menus and dialogs, so it is hidden whenever the tab is not the
 * visible one or anything is layered over the UI.
 */
export function BrowserView({ tab, visible }: { tab: BrowserTab; visible: boolean }) {
  const t = useT()
  const slotRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef(false)
  const renameTab = useWorkspace((s) => s.renameTab)
  const setTabUrl = useWorkspace((s) => s.setTabUrl)
  const overlays = useUi((s) => s.overlays)
  const [address, setAddress] = useState(tab.url)
  const [current, setCurrent] = useState(tab.url)
  const [error, setError] = useState<string | null>(null)

  const shown = visible && overlays === 0

  const measure = useCallback((): Bounds | null => {
    const el = slotRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, [])

  // Create the webview once the placeholder has real dimensions.
  useEffect(() => {
    if (!visible || openedRef.current) return
    const bounds = measure()
    if (!bounds) return
    openedRef.current = true
    // A VS Code tab's saved address names a server and token from an earlier
    // run; the current one is asked for, starting the server if need be.
    const address = tab.vscodeFolder
      ? vscodeWebUrl(tab.vscodeFolder)
      : Promise.resolve(tab.url || 'https://duckduckgo.com')
    void address
      .then((target) => browserOpen(tab.id, target, bounds))
      .then((url) => {
        setCurrent(url)
        setAddress(url)
        setError(null)
      })
      .catch((e) => {
        openedRef.current = false
        setError(String(e))
      })
  }, [measure, tab.id, tab.url, tab.vscodeFolder, visible])

  // Keep the native view aligned with the pane through every layout change.
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const sync = () => {
      if (!openedRef.current) return
      const bounds = measure()
      if (bounds) void browserSetBounds(tab.id, bounds).catch(() => {})
    }
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    sync()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [measure, tab.id])

  useEffect(() => {
    if (!openedRef.current) return
    void browserSetVisible(tab.id, shown).catch(() => {})
    if (shown) {
      const bounds = measure()
      if (bounds) void browserSetBounds(tab.id, bounds).catch(() => {})
    }
  }, [measure, shown, tab.id])

  // Hide it while this component is unmounted — switching projects leaves the
  // webview alive but it must not paint over the project you moved to.
  useEffect(
    () => () => {
      void browserSetVisible(tab.id, false).catch(() => {})
    },
    [tab.id],
  )

  // Links, redirects and history moves are reported by the backend rather
  // than polled for.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onBrowserNavigated(({ id, url }) => {
      if (id !== tab.id || !url) return
      setCurrent(url)
      setAddress(url)
      setTabUrl(tab.id, url)
      // A VS Code tab keeps its name; its host is just 127.0.0.1.
      if (!tab.renamed && !tab.vscodeFolder) renameTab(tab.id, hostOf(url))
    }).then((un) => (unlisten = un))
    return () => unlisten?.()
  }, [renameTab, setTabUrl, tab.id, tab.renamed, tab.vscodeFolder])

  const go = useCallback(
    (value: string) => {
      const bounds = measure()
      if (!bounds) return
      void browserOpen(tab.id, value, bounds)
        .then((url) => {
          openedRef.current = true
          setCurrent(url)
          setAddress(url)
          setTabUrl(tab.id, url)
          setError(null)
        })
        .catch((e) => setError(String(e)))
    },
    [measure, setTabUrl, tab.id],
  )

  return (
    <div className="browser">
      <div className="browser__bar">
        <button
          className="icon-btn" aria-label={t('browser.back')}
          onClick={() => void browserCommand(tab.id, 'back').catch(() => {})}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="icon-btn" aria-label={t('browser.forward')}
          onClick={() => void browserCommand(tab.id, 'forward').catch(() => {})}
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="icon-btn" aria-label={t('browser.reload')}
          onClick={() => void browserCommand(tab.id, 'reload').catch(() => {})}
        >
          <RotateCw size={13} />
        </button>
        <button
          className="icon-btn" aria-label={t('browser.home')}
          onClick={() => go('http://localhost:1420')}
        >
          <Home size={13} />
        </button>
        <input
          className="browser__address mono"
          value={address}
          spellCheck={false}
          placeholder={t('browser.placeholder')}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(address)
            if (e.key === 'Escape') setAddress(current)
          }}
        />
        <button
          className="icon-btn" aria-label={t('browser.openExternal')}
          onClick={() => void openUrl(current).catch(() => {})}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* The native webview is positioned over this box. */}
      <div ref={slotRef} className="browser__slot">
        {error && <div className="empty">{error}</div>}
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
