import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { openUrl } from '@tauri-apps/plugin-opener'
import '@xterm/xterm/css/xterm.css'

import {
  onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyStatus, ptyWrite, scrollbackLoad,
} from '../lib/ipc'
import { buildSpawnOptions, harnessCommandLabel } from '../lib/harness'
import { resolveScheme } from '../lib/schemes'
import { resolveUiTheme } from '../lib/uiThemes'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useTheme } from '../hooks/useTheme'
import { useT } from '../i18n'
import type { TerminalTab } from '../lib/types'

interface Props {
  tab: TerminalTab
  /** The tab is the visible one in its pane; hidden terminals stay alive. */
  visible: boolean
  focused: boolean
}

export function TerminalView({ tab, visible, focused }: Props) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  /** Highest stream offset already written, used to drop replayed batches. */
  const writtenTo = useRef(0)
  const spawning = useRef(false)

  const settings = useSettings((s) => s.settings)
  const isDark = useTheme()
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab.projectId))
  const setTabStatus = useWorkspace((s) => s.setTabStatus)
  const [needsStart, setNeedsStart] = useState(false)

  const commandLabel = harnessCommandLabel(tab.kind, settings)

  // -------------------------------------------------------------- spawn ---
  const spawn = useCallback(
    async (resume: boolean) => {
      const term = termRef.current
      if (!term || spawning.current) return
      spawning.current = true
      try {
        setNeedsStart(false)
        setTabStatus(tab.id, 'starting')
        writtenTo.current = 0
        term.reset()
        const options = buildSpawnOptions({
          tab,
          project,
          settings,
          cols: term.cols,
          rows: term.rows,
          resume,
        })
        await ptySpawn(options)
        setTabStatus(tab.id, 'running')
      } catch (err) {
        setTabStatus(tab.id, 'exited', -1)
        setNeedsStart(true)
        termRef.current?.writeln(
          `\r\n\x1b[31m${String(err)}\x1b[0m\r\n` +
            `\x1b[2mCheck the command in Settings → AI harnesses.\x1b[0m\r\n`,
        )
      } finally {
        spawning.current = false
      }
    },
    [project, settings, setTabStatus, tab],
  )

  // ------------------------------------------------------- create / attach --
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.terminal.cursorBlink,
      cursorStyle: settings.terminal.cursorStyle,
      fontFamily:
        settings.terminal.fontFamily ||
        "'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: settings.terminal.fontSize,
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: resolveScheme(settings.terminal.scheme, isDark, resolveUiTheme(settings.uiTheme)),
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void openUrl(uri).catch(() => {})
      }),
    )
    term.open(host)

    // WebGL keeps large redraws off the main thread; software rendering is a
    // fine fallback on machines where the context cannot be created.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* canvas renderer */
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    fit.fit()

    let disposed = false
    const unlisteners: Array<() => void> = []
    /** Batches that arrive while the snapshot is still loading. */
    const pending: Array<{ bytes: Uint8Array; end: number }> = []
    let ready = false

    const writeBatch = (bytes: Uint8Array, end: number) => {
      const start = end - bytes.length
      if (end <= writtenTo.current) return // already covered by the snapshot
      const slice = start < writtenTo.current ? bytes.subarray(writtenTo.current - start) : bytes
      writtenTo.current = end
      term.write(slice)
    }

    void (async () => {
      // Subscribe before snapshotting so nothing emitted in between is lost;
      // the offsets then tell us exactly what to discard as duplicate.
      unlisteners.push(
        await onPtyData(tab.id, (bytes, end) => {
          if (ready) writeBatch(bytes, end)
          else pending.push({ bytes, end })
        }),
      )
      unlisteners.push(
        await onPtyExit(tab.id, (code) => {
          setTabStatus(tab.id, 'exited', code)
          setNeedsStart(true)
          term.write(`\r\n\x1b[2m— ${t('tabs.exited', { code })} —\x1b[0m\r\n`)
        }),
      )
      if (disposed) return

      const status = await ptyStatus(tab.id)
      if (settings.startup.restoreScrollback) {
        const snap = await scrollbackLoad(tab.id)
        if (disposed) return
        if (snap.bytes.length) {
          term.write(snap.bytes)
          if (snap.live) writtenTo.current = snap.end
        }
        if (!snap.live && snap.bytes.length) {
          term.write('\r\n\x1b[2m' + '─'.repeat(Math.max(8, term.cols - 2)) + '\x1b[0m\r\n')
        }
      }
      ready = true
      for (const p of pending) writeBatch(p.bytes, p.end)
      pending.length = 0

      if (status.running && status.alive) {
        setTabStatus(tab.id, 'running')
        return
      }
      // Nothing is running: either start it now or wait for the user.
      if (settings.startup.autoStartTabs || tab.status === 'idle') {
        if (settings.startup.autoStartTabs) {
          await spawn(tab.resumeOnRestore)
          return
        }
      }
      setNeedsStart(true)
    })()

    const onData = term.onData((data) => {
      void ptyWrite(tab.id, data).catch(() => {})
    })
    const onResize = term.onResize(({ cols, rows }) => {
      void ptyResize(tab.id, cols, rows).catch(() => {})
    })

    const ro = new ResizeObserver(() => {
      // Zero-sized while hidden; fitting then would corrupt the layout.
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* mid-teardown */
        }
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      for (const un of unlisteners) un()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // The terminal instance is deliberately created once per tab: settings
    // changes are applied imperatively below rather than by re-creating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // --------------------------------------------------- live settings apply --
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = resolveScheme(
      settings.terminal.scheme,
      isDark,
      resolveUiTheme(settings.uiTheme),
    )
    term.options.fontFamily =
      settings.terminal.fontFamily ||
      "'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace"
    term.options.fontSize = settings.terminal.fontSize
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.cursorStyle = settings.terminal.cursorStyle
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.scrollback = settings.terminal.scrollback
    try {
      fitRef.current?.fit()
    } catch {
      /* not laid out yet */
    }
  }, [
    isDark,
    settings.uiTheme,
    settings.terminal.scheme,
    settings.terminal.fontFamily,
    settings.terminal.fontSize,
    settings.terminal.lineHeight,
    settings.terminal.cursorStyle,
    settings.terminal.cursorBlink,
    settings.terminal.scrollback,
  ])

  // Re-fit and focus when the tab comes back into view.
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* not laid out yet */
      }
      if (focused) termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, focused])

  // ------------------------------------------------ selection / clipboard --
  useEffect(() => {
    const term = termRef.current
    if (!term || !settings.terminal.copyOnSelect) return
    const sub = term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
    })
    return () => sub.dispose()
  }, [settings.terminal.copyOnSelect])

  const onContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      if (!settings.terminal.rightClickPaste) return
      e.preventDefault()
      const term = termRef.current
      if (!term) return
      const sel = term.getSelection()
      if (sel) {
        await navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        return
      }
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text) void ptyWrite(tab.id, text).catch(() => {})
    },
    [settings.terminal.rightClickPaste, tab.id],
  )

  return (
    <div className="term" onContextMenu={onContextMenu}>
      <div ref={hostRef} className="term__host" />
      {needsStart && (
        <div className="term__start">
          <button
            className="btn btn--primary"
            onClick={() => void spawn(tab.resumeOnRestore && tab.kind !== 'shell')}
          >
            {t('tabs.start')}
          </button>
          <p className="term__start-hint">
            {t('tabs.startHint', { command: commandLabel || 'shell', folder: tab.cwd })}
          </p>
        </div>
      )}
    </div>
  )
}

/** Kills the backing process. Called when a tab is closed, not when hidden. */
export const disposeTabProcess = (id: string) => void ptyKill(id).catch(() => {})
