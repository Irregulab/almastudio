import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Pin, Smartphone, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { openUrl } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import '@xterm/xterm/css/xterm.css'

import {
  onAgentPrompt, onConversationReset, onPtyData, onPtyExit, onPtySizeOwner, promptHistory,
  ptyClaim, ptyResize, ptySizeOwnerRemote, ptySpawn, ptyStatus, ptyWrite, scrollbackLoad,
} from '../lib/ipc'
import { buildSpawnOptions, harnessCommandLabel } from '../lib/harness'
import { claudeSessionFor } from '../lib/claudeSession'
import { resolveScheme } from '../lib/schemes'
import { terminalFontStack } from '../lib/fonts'
import { resolveUiTheme } from '../lib/uiThemes'
import { useDrag } from '../lib/dragDrop'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useRemote } from '../store/remote'
import { useUi } from '../store/ui'
import { useTheme } from '../hooks/useTheme'
import { useT } from '../i18n'
import { TerminalImages } from '../lib/terminalImages'
import { nextStep, promptRows, type Cell, type Point, type RowReader } from '../lib/clickCursor'
import {
  findPinned, messageAt, messageFrom, normalize, type PinCell, type PinRowReader,
} from '../lib/pinnedMessages'
import type { PinnedMessage, SentPrompt, TerminalTab } from '../lib/types'
import { PinnedBar } from './PinnedBar'

/**
 * What returns a terminal to its default modes after it has replayed the
 * output of a program that is no longer running. Otherwise the next program
 * starts in whatever modes the old one left on: with focus reporting, say,
 * every focus change sends `ESC [ I` into the new process, and a shell echoes
 * it as `^[[I`. Unlike a full reset, this leaves the restored output on screen.
 */
function defaultModes(term: Terminal): string {
  // Leaving the alternate screen also restores the cursor saved on entering
  // it, which anywhere else would move the cursor, so only when it is on.
  const altScreen = term.buffer.active.type === 'alternate' ? '\x1b[?1049l' : ''
  // CAN abandons a sequence the old output was cut off in the middle of; then
  // mouse reporting off, and a soft reset (DECSTR) for the rest: focus
  // reporting, bracketed paste, cursor keys, a hidden cursor, scroll region.
  return '\x18' + altScreen + '\x1b[?1000l\x1b[!p'
}

/** The rows of the buffer on screen now, with what finding a pinned message needs. */
function pinReader(term: Terminal): PinRowReader {
  const buffer = term.buffer.active
  const scratch = buffer.getNullCell()
  return (y) => {
    const line = buffer.getLine(y)
    if (!line) return undefined
    const cells: PinCell[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x, scratch)
      cells.push(
        c
          ? {
              chars: c.getChars(),
              width: c.getWidth(),
              // The mode keeps palette colour 1 apart from RGB #000001.
              bg: c.isBgDefault() ? -1 : c.getBgColorMode() + c.getBgColor(),
            }
          : { chars: '', width: 1, bg: -1 },
      )
    }
    return { cells, wrapped: line.isWrapped }
  }
}

/**
 * Resolves once the program has redrawn after a key — nothing more written
 * for `quietMs` — or after `limitMs` when it does not.
 */
function redrawn(term: Terminal, quietMs = 30, limitMs = 400): Promise<void> {
  return new Promise<void>((resolve) => {
    let quiet: number | undefined
    const done = () => {
      sub.dispose()
      window.clearTimeout(quiet)
      window.clearTimeout(limit)
      resolve()
    }
    const sub = term.onWriteParsed(() => {
      window.clearTimeout(quiet)
      quiet = window.setTimeout(done, quietMs)
    })
    const limit = window.setTimeout(done, limitMs)
  })
}

/** The top half of the screen: what paging changes, and a spinner below does not. */
function screenTop(term: Terminal): string {
  const b = term.buffer.active
  let s = ''
  for (let y = 0; y < Math.ceil(term.rows / 2); y++) {
    s += (b.getLine(b.viewportY + y)?.translateToString(true) ?? '') + '\n'
  }
  return s
}

/** Where the button pinning a message sits: a row of the terminal, and the text. */
interface PinSpot {
  /** The row's middle, in pixels from the top of the terminal's body. */
  y: number
  text: string
  /** A selection, rather than a request sent to Claude Code. */
  selection: boolean
}

/** How long a message shown from its pin stays marked. */
const PIN_FLASH_MS = 1200
/** The keys Claude Code's fullscreen view pages through the conversation with. */
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
/** How many pages a search for a pinned message turns, each way, at most. */
const MAX_PAGES = 300
/** How many of the requests sent from a tab its list shows; as many as the backend keeps. */
const MAX_HISTORY = 500

interface Props {
  tab: TerminalTab
  /** The tab is the visible one in its pane; hidden terminals stay alive. */
  visible: boolean
  focused: boolean
}

const MAX_PENDING_BYTES = 512 * 1024

export function TerminalView({ tab, visible, focused }: Props) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const imagesRef = useRef<TerminalImages | null>(null)
  /** Highest stream offset already written, used to drop replayed batches. */
  const writtenTo = useRef(0)
  const spawning = useRef(false)
  /** The size the pty was last told, as `colsxrows@WxH`; null when unknown. */
  const ptySize = useRef<string | null>(null)

  const settings = useSettings((s) => s.settings)
  const isDark = useTheme()
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab.projectId))
  const setTabStatus = useWorkspace((s) => s.setTabStatus)
  const setTabCwd = useWorkspace((s) => s.setTabCwd)
  const pinMessage = useWorkspace((s) => s.pinMessage)
  const unpinMessage = useWorkspace((s) => s.unpinMessage)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [pinSpot, setPinSpot] = useState<PinSpot | null>(null)
  /** The requests sent from a Claude tab, oldest first. */
  const [history, setHistory] = useState<SentPrompt[]>([])
  /** Bumped by each search for a pinned message, and by a key or click, which end the one before. */
  const pinWalk = useRef(0)
  const [needsStart, setNeedsStart] = useState(false)
  // The custom key handler is attached once, so it reads current values
  // through refs rather than closing over the first render's.
  const needsStartRef = useRef(false)
  const spawnRef = useRef<(resume: boolean) => void>(() => {})
  const [findOpen, setFindOpen] = useState(false)
  const [findTerm, setFindTerm] = useState('')
  const [findHits, setFindHits] = useState<{ index: number; count: number } | null>(null)
  const fileDropTarget = useDrag((s) => s.fileDropTab === tab.id)
  // A phone or tablet has the pty sized for its own screen. The desktop takes
  // its size back as soon as it is typed or clicked in.
  const [remoteSized, setRemoteSized] = useState(false)
  const remoteSizedRef = useRef(false)
  remoteSizedRef.current = remoteSized
  const claimSize = useCallback(() => {
    if (remoteSizedRef.current) void ptyClaim(tab.id).catch(() => {})
  }, [tab.id])

  const commandLabel = harnessCommandLabel(tab.kind, settings)
  needsStartRef.current = needsStart

  /**
   * Tells the pty the terminal's size when it was last told another. A resize
   * sent while the process is still starting fails, and a program left
   * drawing for a width the terminal no longer has garbles all it draws.
   */
  const syncPtySize = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // In pixels too: programs that draw images size them from it.
    const px = imagesRef.current?.screenSize() ?? { width: 0, height: 0 }
    const size = `${term.cols}x${term.rows}@${px.width}x${px.height}`
    if (ptySize.current === size) return
    void ptyResize(tab.id, term.cols, term.rows, px.width, px.height)
      .then(() => {
        ptySize.current = size
      })
      .catch(() => {})
  }, [tab.id])

  // -------------------------------------------------------------- spawn ---
  const spawn = useCallback(
    async (resume: boolean, keepScreen = false) => {
      const term = termRef.current
      if (!term || spawning.current) return
      spawning.current = true
      try {
        setNeedsStart(false)
        setTabStatus(tab.id, 'starting')
        writtenTo.current = 0
        // A tab starting as it opens keeps the output restored from its last
        // run above the separator; any other start begins on a clean screen.
        if (!keepScreen) {
          term.reset()
          imagesRef.current?.reset()
        }
        // Which Claude conversation this tab is on, so it resumes its own.
        const claudeSession =
          tab.kind === 'claude' ? await claudeSessionFor(tab.id, resume) : undefined
        const { cols, rows } = term
        const options = buildSpawnOptions({
          tab,
          project,
          settings,
          cols,
          rows,
          resume,
          claudeSession,
        })
        await ptySpawn(options)
        ptySize.current = `${cols}x${rows}@0x0`
        // The terminal may have been resized while the process started.
        syncPtySize()
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
    [project, settings, setTabStatus, syncPtySize, tab],
  )
  spawnRef.current = spawn

  // ------------------------------------------------------- create / attach --
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.terminal.cursorBlink,
      cursorStyle: settings.terminal.cursorStyle,
      fontFamily: terminalFontStack(settings.terminal.fontFamily),
      fontSize: settings.terminal.fontSize,
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: resolveScheme(settings.terminal.scheme, isDark, resolveUiTheme(settings.uiTheme)),
      // Off unless asked for: Option has to type what the keyboard layout
      // puts on it — on an Italian Mac ~ @ # [ ] { } are all Option keys.
      macOptionIsMeta: settings.terminal.optionIsMeta,
      // Links a program marks itself (OSC 8), whose visible text need not be
      // the URL. xterm's fallback is confirm() then window.open(), neither of
      // which reaches the system browser from inside the webview.
      linkHandler: {
        activate: (_e, uri) => void openUrl(uri).catch(() => {}),
      },
      // Programs that draw images ask for the cell size in pixels (CSI 16 t).
      windowOptions: { getCellSizePixels: true, getWinSizePixels: true },
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

    termRef.current = term
    // Claude Code's fullscreen view lives on the alternate screen; the pane
    // menu offers the switch the other way round.
    const watchScreen = tab.kind === 'claude'
      ? term.buffer.onBufferChange((b) => useUi.getState().setTabFullscreen(tab.id, b.type === 'alternate'))
      : null
    fitRef.current = fit
    searchRef.current = search
    const searchResults = search.onDidChangeResults((r) =>
      setFindHits(r ? { index: r.resultIndex + 1, count: r.resultCount } : null),
    )
    fit.fit()

    // OSC 7 — shells (bash, zsh, fish) emit this to report the current working
    // directory after each prompt. We persist it so that a restarted tab opens
    // in the directory the user was actually in, not the original spawn cwd.
    const osc7 = term.parser.registerOscHandler(7, (data) => {
      try {
        // Format: file://hostname/path  (hostname may be empty → file:///path)
        const url = new URL(data)
        if (url.protocol === 'file:') {
          setTabCwd(tab.id, decodeURIComponent(url.pathname))
        }
      } catch {
        // Malformed OSC 7 payload — ignore.
      }
      return false // allow other handlers to run
    })

    let disposed = false
    const unlisteners: Array<() => void> = []
    /** Batches that arrive while the snapshot is still loading. */
    const pending: Array<{ bytes: Uint8Array; end: number }> = []
    let pendingBytes = 0
    let ready = false
    /** Restored output is being parsed; see onData. */
    let replaying = false
    // Images sent with the kitty graphics protocol. Answers to its commands
    // go to the program like those xterm gives, and are held back the same
    // way while replaying.
    const images = new TerminalImages(term, (data) => {
      if (!replaying) void ptyWrite(tab.id, data).catch(() => {})
    })
    images.attach()
    imagesRef.current = images

    /** Resolves once everything written so far has been parsed. */
    const flushed = () => new Promise<void>((resolve) => term.write('', resolve))

    /**
     * Resolves once the terminal has been laid out at a real size. A hidden
     * terminal is 80×24, and output replayed or a program started at that
     * size is garbled once the terminal is shown at its own.
     */
    let markSized = () => {}
    const sized = new Promise<void>((resolve) => {
      markSized = resolve
    })
    let hasSize = false
    let fitTimer: number | undefined
    const fitNow = () => {
      try {
        fit.fit()
      } catch {
        /* mid-teardown */
      }
    }
    const ro = new ResizeObserver(() => {
      // Zero-sized while hidden; fitting then would corrupt the layout.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      if (!hasSize) {
        hasSize = true
        fitNow()
        markSized()
        return
      }
      // Once the size settles: dragging the window's edge otherwise sends the
      // program a resize, and a full redraw, for every pixel on the way, each
      // reflowing the screen under the redraw before it.
      window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(fitNow, 100)
    })
    ro.observe(host)

    /**
     * A start asked for from the companion app. The tab may be hidden — in a
     * project or tab nobody has looked at on this screen — and a hidden
     * terminal never gets a size, so it borrows the phone's until it is shown.
     */
    let startWhenReady = false
    let handledStart = 0
    const takeRemoteStart = () => {
      const start = useRemote.getState().starts[tab.id]
      if (!start || start.nonce <= handledStart) return
      handledStart = start.nonce
      // Dropped only once this mount has taken it: in development React
      // mounts every component twice, and the second mount needs it too.
      window.setTimeout(() => useRemote.getState().consumeStart(tab.id, start.nonce), 0)
      if (!hasSize) {
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          hasSize = true
          fitNow()
        } else {
          try {
            term.resize(Math.max(20, start.cols), Math.max(5, start.rows))
          } catch {
            /* mid-teardown */
          }
        }
        markSized()
      }
      if (start.mode === 'restart') {
        if (ready) spawnRef.current(tab.kind !== 'shell')
        else startWhenReady = true
      } else if (start.mode === 'start') {
        if (ready && needsStartRef.current) {
          spawnRef.current(tab.resumeOnRestore && tab.kind !== 'shell')
        } else if (!ready) {
          startWhenReady = true
        }
      }
    }
    takeRemoteStart()
    const unsubStarts = useRemote.subscribe((st, prev) => {
      if (st.starts[tab.id] && st.starts[tab.id] !== prev.starts[tab.id]) takeRemoteStart()
    })

    const writeBatch = (bytes: Uint8Array, end: number) => {
      const start = end - bytes.length
      if (end <= writtenTo.current) return // already covered by the snapshot
      const slice = start < writtenTo.current ? bytes.subarray(writtenTo.current - start) : bytes
      writtenTo.current = end
      term.write(images.write(slice))
    }

    void (async () => {
      await sized
      if (disposed) return
      // Subscribe before snapshotting so nothing emitted in between is lost;
      // the offsets then tell us exactly what to discard as duplicate.
      const unlistenData = await onPtyData(tab.id, (bytes, end) => {
        if (ready) writeBatch(bytes, end)
        else {
          pending.push({ bytes, end })
          pendingBytes += bytes.length
          while (pendingBytes > MAX_PENDING_BYTES) {
            const dropped = pending.shift()
            if (!dropped) break
            pendingBytes -= dropped.bytes.length
          }
        }
      })
      if (disposed) {
        unlistenData()
        return
      }
      unlisteners.push(unlistenData)

      const unlistenExit = await onPtyExit(tab.id, (code) => {
        setTabStatus(tab.id, 'exited', code)
        setNeedsStart(true)
        term.write(`\r\n\x1b[2m— ${t('tabs.exited', { code })} —\x1b[0m\r\n`)
      })
      if (disposed) {
        unlistenExit()
        return
      }
      unlisteners.push(unlistenExit)

      const unlistenOwner = await onPtySizeOwner(tab.id, (remote) => setRemoteSized(remote))
      if (disposed) {
        unlistenOwner()
        return
      }
      unlisteners.push(unlistenOwner)
      if (disposed) return

      const status = await ptyStatus(tab.id)
      if (settings.startup.restoreScrollback) {
        const snap = await scrollbackLoad(tab.id)
        if (disposed) return
        if (snap.bytes.length) {
          // Replayed output is parsed like live output, so the queries in it
          // are answered again: Claude Code asks for the terminal's attributes
          // as it starts. Those answers are held back (see onData), and the
          // tab starts only once the replay is parsed — written just before a
          // start, it used to be parsed after, and the answers reached the
          // new process before it had turned echo off.
          replaying = true
          term.write(images.write(snap.bytes))
          if (snap.live) {
            writtenTo.current = snap.end
          } else {
            await flushed()
            if (disposed) return
            // Like the CAN below, for a graphics command the output ends in.
            images.abandon()
            term.write(
              defaultModes(term) +
                '\r\n\x1b[2m' + '─'.repeat(Math.max(8, term.cols - 2)) + '\x1b[0m\r\n',
            )
          }
          await flushed()
          if (disposed) return
          replaying = false
        }
      }
      ready = true
      for (const p of pending) writeBatch(p.bytes, p.end)
      pending.length = 0
      pendingBytes = 0

      if (status.running && status.alive) {
        setTabStatus(tab.id, 'running')
        // Whatever size it was last given, it is now this terminal's.
        ptySize.current = null
        syncPtySize()
        void ptySizeOwnerRemote(tab.id).then((remote) => {
          if (!disposed) setRemoteSized(remote)
        }).catch(() => {})
        if (startWhenReady) {
          startWhenReady = false
          await spawn(tab.kind !== 'shell')
        }
        return
      }
      if (startWhenReady) {
        startWhenReady = false
        await spawn(tab.resumeOnRestore && tab.kind !== 'shell', true)
        return
      }
      // Nothing is running. Opening a tab is already the instruction to start
      // it, so a fresh tab never asks; only a tab restored from a previous run
      // defers to the setting, since relaunching agents on every app start is
      // a decision the user should get to make.
      if (!tab.restored || settings.startup.autoStartTabs) {
        await spawn(tab.resumeOnRestore, true)
        return
      }
      setNeedsStart(true)
    })()

    const windows = platform() === 'windows'

    // The hint says "press Enter to start"; make that true. Nothing is
    // listening on the other end until a process exists, so the keystroke is
    // free to reuse.
    term.attachCustomKeyEventHandler((e) => {
      // Typing here is using the desktop again: it gets its size back.
      if (e.type === 'keydown' && remoteSizedRef.current) {
        void ptyClaim(tab.id).catch(() => {})
      }
      if (e.type === 'keydown' && e.key === 'Enter' && needsStartRef.current) {
        spawnRef.current(tab.resumeOnRestore && tab.kind !== 'shell')
        return false
      }
      // Ctrl+C and Ctrl+V copy and paste on Windows, as in Windows Terminal;
      // xterm would send the program both as control characters. Ctrl+C
      // copies only a selection and is the interrupt otherwise. The default
      // is prevented so the webview cannot paste a second time on its own.
      if (windows && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'c' && term.hasSelection()) {
          if (e.type === 'keydown') {
            e.preventDefault()
            void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
            term.clearSelection()
          }
          return false
        }
        if (key === 'v') {
          if (e.type === 'keydown') {
            e.preventDefault()
            void navigator.clipboard.readText().catch(() => '').then((text) => {
              // Through xterm, so the program gets one (bracketed) paste.
              if (text) term.paste(text)
              // No text — an image, say: Claude Code reads that itself on ^V.
              else void ptyWrite(tab.id, '\x16').catch(() => {})
            })
          }
          return false
        }
      }
      // xterm sends Shift+Enter as a plain Enter, so an agent would submit
      // instead of starting a new line. Send what Option+Enter sends (ESC CR),
      // which Claude Code and OpenCode take as "new line". A shell keeps the
      // plain Enter a native terminal gives it. Swallowed for keypress and
      // keyup too, or xterm would still emit its own Enter.
      if (
        tab.kind !== 'shell' && e.key === 'Enter' && e.shiftKey &&
        !e.altKey && !e.ctrlKey && !e.metaKey
      ) {
        if (e.type === 'keydown') void ptyWrite(tab.id, '\x1b\r').catch(() => {})
        return false
      }
      return true
    })

    const onData = term.onData((data) => {
      // Answers to queries in replayed output: a program long gone asked
      // them, and the one running now would take them for typed input.
      if (replaying) return
      void ptyWrite(tab.id, data).catch(() => {})
    })
    const onResize = term.onResize(() => syncPtySize())

    return () => {
      disposed = true
      ro.disconnect()
      unsubStarts()
      window.clearTimeout(fitTimer)
      markSized()
      osc7.dispose()
      onData.dispose()
      watchScreen?.dispose()
      useUi.getState().setTabFullscreen(tab.id, false)
      onResize.dispose()
      searchResults.dispose()
      for (const un of unlisteners) un()
      images.dispose()
      imagesRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // The terminal instance is deliberately created once per tab: settings
    // changes are applied imperatively below rather than by re-creating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // WebGL keeps large redraws off the main thread, but the context it holds
  // is a limited platform resource, not a free one. Every opened project's
  // terminals used to be unmounted — and their contexts released — the
  // moment another project came to front; now they stay mounted hidden, so
  // holding a context per tab regardless of visibility would grow one per
  // terminal ever opened in the session, and eventually exhaust the budget
  // and blank the whole window. So the context is only held while this tab
  // is actually the one on screen; xterm's own canvas renderer is a fine
  // substitute while hidden, same as on a machine where WebGL never works.
  useEffect(() => {
    const term = termRef.current
    if (!term || !visible) return
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl?.dispose())
      term.loadAddon(webgl)
    } catch {
      /* canvas renderer */
    }
    return () => webgl?.dispose()
  }, [visible])

  // --------------------------------------------------- live settings apply --
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = resolveScheme(
      settings.terminal.scheme,
      isDark,
      resolveUiTheme(settings.uiTheme),
    )
    term.options.fontFamily = terminalFontStack(settings.terminal.fontFamily)
    term.options.fontSize = settings.terminal.fontSize
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.cursorStyle = settings.terminal.cursorStyle
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.scrollback = settings.terminal.scrollback
    term.options.macOptionIsMeta = settings.terminal.optionIsMeta
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
    settings.terminal.optionIsMeta,
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

  // Back from another window (Alt-Tab), the webview refocuses whatever had
  // focus last — on Windows that is often the tab button just clicked, since
  // WebView2 focuses buttons on click. Typing should go to the terminal, so
  // it takes focus back unless a text field had it.
  useEffect(() => {
    if (!visible || !focused) return
    let frame = 0
    const onWindowFocus = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null
        const typing = el?.closest(
          'input, select, [contenteditable=""], [contenteditable="true"], textarea:not(.xterm-helper-textarea)',
        )
        if (!typing) termRef.current?.focus()
      })
    }
    window.addEventListener('focus', onWindowFocus)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [visible, focused])

  // Restart requested from the tab's context menu.
  useEffect(() => {
    const onRestart = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== tab.id) return
      // A deliberate restart resumes the agent's previous session where the
      // harness supports it, which is what "restart this tab" should mean.
      void spawn(tab.kind !== 'shell')
    }
    window.addEventListener('almastudio:tab-restart', onRestart)
    return () => window.removeEventListener('almastudio:tab-restart', onRestart)
  }, [spawn, tab.id, tab.kind])

  // Text sent to this terminal from elsewhere in the app: the paths of files
  // dropped on it from Finder or Explorer, or a finished review. Pasted
  // rather than written straight to the pty, so the program receives it as
  // a paste — bracketed when it asked for that — exactly as from a native
  // terminal's drop.
  useEffect(() => {
    const onPaste = (e: Event) => {
      const { tabId, text, submit } =
        (e as CustomEvent<{ tabId: string; text: string; submit?: boolean }>).detail
      if (tabId !== tab.id) return
      termRef.current?.paste(text)
      termRef.current?.focus()
      // Enter goes on its own, a moment later: sent with the paste, a harness
      // takes it for one more line of it. The companion app waits as long.
      if (submit) window.setTimeout(() => void ptyWrite(tab.id, '\r').catch(() => {}), 150)
    }
    window.addEventListener('almastudio:paste', onPaste)
    return () => window.removeEventListener('almastudio:paste', onPaste)
  }, [tab.id])

  // --------------------------------------------------------------- find ---
  useEffect(() => {
    if (!focused) return
    const open = () => setFindOpen(true)
    window.addEventListener('almastudio:find', open)
    return () => window.removeEventListener('almastudio:find', open)
  }, [focused])

  const runSearch = useCallback(
    (term: string, back = false) => {
      const search = searchRef.current
      if (!search) return
      if (!term) {
        search.clearDecorations()
        setFindHits(null)
        return
      }
      const options = {
        decorations: {
          matchOverviewRuler: '#f5f543',
          activeMatchColorOverviewRuler: '#f5f543',
          matchBackground: '#623315',
          activeMatchBackground: '#9e6a03',
        },
      }
      if (back) search.findPrevious(term, options)
      else search.findNext(term, options)
    },
    [],
  )

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindTerm('')
    setFindHits(null)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }, [])

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

  // ------------------------------------------------------------- pins ---
  // A button at the right of the row: on the request to Claude Code under
  // the mouse, or at the end of a selection, in any terminal.
  useEffect(() => {
    const term = termRef.current
    const body = bodyRef.current
    if (!term || !body) return

    /** Where the mouse is, while it is over the terminal. */
    let mouseY: number | null = null
    let frame = 0

    const spot = (): PinSpot | null => {
      const range = term.getSelectionPosition()
      // Nothing to pin: spares the layout reads on every write of output.
      if (!range && (tab.kind !== 'claude' || mouseY === null)) return null
      const screen = term.element?.querySelector('.xterm-screen')
      if (!screen) return null
      const r = screen.getBoundingClientRect()
      if (r.height === 0) return null
      const cellH = r.height / term.rows
      const top = r.top - body.getBoundingClientRect().top
      const viewport = term.buffer.active.viewportY
      const at = (y: number) => top + (y - viewport + 0.5) * cellH
      const onScreen = (y: number) => y >= viewport && y < viewport + term.rows

      if (range) {
        const text = term.getSelection().trim()
        const end = Math.max(range.start.y, range.end.y)
        return text && onScreen(end) ? { y: at(end), text, selection: true } : null
      }
      if (mouseY === null) return null
      const row = Math.floor((mouseY - r.top) / cellH)
      if (row < 0 || row >= term.rows) return null
      const message = messageAt(pinReader(term), viewport + row)
      if (!message?.text.trim()) return null
      // On its first row, or the top one on screen when that has scrolled away.
      return { y: at(Math.max(message.first, viewport)), text: message.text, selection: false }
    }

    const update = () => {
      frame = 0
      const next = spot()
      setPinSpot((prev) =>
        prev && next && prev.y === next.y && prev.text === next.text &&
          prev.selection === next.selection
          ? prev
          : next,
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    // Captured: a program reading the mouse has xterm stop the events there.
    const onMove = (e: MouseEvent) => {
      mouseY = e.clientY
      schedule()
    }
    const onLeave = () => {
      mouseY = null
      schedule()
    }
    body.addEventListener('mousemove', onMove, true)
    body.addEventListener('mouseleave', onLeave)
    // Using the terminal ends a search for a pinned message still paging.
    const stopWalk = () => {
      pinWalk.current++
    }
    for (const type of ['keydown', 'mousedown', 'wheel']) body.addEventListener(type, stopWalk, true)
    // What is under a still mouse changes as output scrolls or is redrawn.
    const subs = [
      term.onScroll(schedule),
      term.onSelectionChange(schedule),
      term.onWriteParsed(schedule),
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
    ]
    return () => {
      cancelAnimationFrame(frame)
      body.removeEventListener('mousemove', onMove, true)
      body.removeEventListener('mouseleave', onLeave)
      for (const type of ['keydown', 'mousedown', 'wheel']) body.removeEventListener(type, stopWalk, true)
      pinWalk.current++
      for (const s of subs) s.dispose()
    }
  }, [tab.id, tab.kind])

  // The requests sent from the tab: those kept, then each as it is sent,
  // until the conversation starts over.
  useEffect(() => {
    setHistory([])
    if (tab.kind !== 'claude') return
    let live = true
    const unlisten: Array<() => void> = []
    // Tauri can fail to take a listener off the moment it is in place — as
    // React's StrictMode does to every effect — and leave it listening, so
    // the listeners check they are still wanted.
    const keep = (u: () => void) => {
      if (live) unlisten.push(u)
      else void Promise.resolve(u()).catch(() => {})
    }
    void onAgentPrompt(({ tabId, prompt }) => {
      if (!live || tabId !== tab.id) return
      setHistory((h) =>
        h.some((p) => p.at === prompt.at && p.text === prompt.text)
          ? h
          : [...h, prompt].slice(-MAX_HISTORY),
      )
    }).then(keep)
    void onConversationReset((tabId) => {
      if (live && tabId === tab.id) setHistory([])
    }).then(keep)
    void promptHistory(tab.id)
      .then((kept) => {
        if (!live) return
        // Any sent while they were read is in them, or after them.
        const end = kept[kept.length - 1]?.at ?? 0
        setHistory((h) => [...kept, ...h.filter((p) => p.at > end)].slice(-MAX_HISTORY))
      })
      .catch(() => {})
    return () => {
      live = false
      for (const u of unlisten) void Promise.resolve(u()).catch(() => {})
    }
  }, [tab.id, tab.kind])

  /** Puts a request back in the prompt, to be changed and sent again. */
  const insertRequest = useCallback((text: string) => {
    const term = termRef.current
    if (!term) return
    // As a paste, which Claude Code takes whole. A program that has not asked
    // for pastes marked as such would take each newline for Enter.
    term.paste(term.modes.bracketedPasteMode ? text : text.replace(/\s*\n\s*/g, ' '))
    term.focus()
  }, [])

  const pinned = (text: string) =>
    tab.pins?.find((p) => normalize(p.text) === normalize(text))

  const togglePin = () => {
    const term = termRef.current
    if (!pinSpot || !term) return
    const existing = pinned(pinSpot.text)
    if (existing) unpinMessage(tab.id, existing.id)
    else pinMessage(tab.id, pinSpot.text, pinSpot.selection)
    if (pinSpot.selection) term.clearSelection()
    term.focus()
  }

  /**
   * Scrolls to a pinned message and marks it for a moment. False when it is
   * gone; true too when a key or click in the terminal cut the search short.
   */
  const showPin = useCallback(async (pin: PinnedMessage): Promise<boolean> => {
    const term = termRef.current
    if (!term) return false
    const id = ++pinWalk.current
    const fullscreen = tab.kind === 'claude' && term.buffer.active.type === 'alternate'
    // Scrolled back, Claude Code's fullscreen view keeps the request of the
    // turn on screen in its top row after its own row has gone by: a request
    // there is taken only once there is nothing further back.
    const top = fullscreen && !pin.selection ? 1 : 0
    const find = (from = top) =>
      findPinned(pinReader(term), from, term.buffer.active.length - 1, pin)
    let y = find()

    // That view keeps the conversation to itself and puts one screen of it in
    // the terminal, so it is paged through: back first, where a pinned
    // request nearly always is, then forward, each way until the page stops
    // changing.
    if (y === null && fullscreen) {
      for (const key of [PAGE_UP, PAGE_DOWN]) {
        for (let i = 0; i < MAX_PAGES && y === null; i++) {
          if (id !== pinWalk.current) return true
          const before = screenTop(term)
          const wait = redrawn(term, 40, 600)
          void ptyWrite(tab.id, key).catch(() => {})
          await wait
          // Slow to redraw while it works: once more before taking it for the end.
          if (screenTop(term) === before) await redrawn(term, 40, 600)
          if (screenTop(term) === before) {
            // The start of the conversation: its top row is its own.
            if (key === PAGE_UP) y = find(0)
            break
          }
          y = find()
        }
        if (y !== null) break
      }
      if (id !== pinWalk.current) return true
    }
    if (y === null) return false

    const read = pinReader(term)
    const b = term.buffer.active
    // A couple of rows of what led to it above.
    term.scrollToLine(Math.max(0, y - 2))
    const rows = (messageFrom(read, y)?.last ?? y) - y + 1
    const marker = term.registerMarker(y - (b.baseY + b.cursorY))
    const mark = marker && term.registerDecoration({ marker, width: term.cols, height: rows })
    mark?.onRender((el) => el.classList.add('term__pin-flash'))
    window.setTimeout(() => {
      mark?.dispose()
      marker?.dispose()
    }, PIN_FLASH_MS)
    term.focus()
    return true
  }, [tab.id, tab.kind])

  // ------------------------------------------------- click to move caret --
  // A plain click in Claude Code's prompt takes its caret there, as the
  // mouse does in Codex and OpenCode; see lib/clickCursor. Never while the
  // program reports the mouse itself, nor in a full-screen one.
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host || tab.kind !== 'claude' || !settings.terminal.clickMovesCursor) return

    const scratch = term.buffer.active.getNullCell()
    const read: RowReader = (y) => {
      const line = term.buffer.active.getLine(y)
      if (!line) return undefined
      const cells: Cell[] = []
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x, scratch)
        cells.push(
          c
            ? { chars: c.getChars(), width: c.getWidth(), dim: c.isDim() !== 0 }
            : { chars: '', width: 1, dim: false },
        )
      }
      return cells
    }
    const caret = (): Point => {
      const b = term.buffer.active
      return { x: b.cursorX, y: b.baseY + b.cursorY }
    }
    const applies = () =>
      !needsStartRef.current &&
      term.buffer.active.type === 'normal' &&
      term.modes.mouseTrackingMode === 'none'

    /** Bumped by every click and key, which each end the walk before. */
    let walk = 0
    const moveTo = async (target: Point) => {
      const id = ++walk
      const start = promptRows(read, caret().y)
      if (!start) return
      for (let i = 0; i < 64 && id === walk && applies(); i++) {
        const from = caret()
        // The prompt moved — output above it — so the row clicked is gone.
        if (promptRows(read, from.y)?.first !== start.first) return
        const keys = nextStep(read, from, target, term.modes.applicationCursorKeysMode)
        if (!keys) return
        const wait = redrawn(term)
        void ptyWrite(tab.id, keys).catch(() => {})
        await wait
        const to = caret()
        if (to.x === from.x && to.y === from.y) return // the keys did nothing
      }
    }

    let down: { clientX: number; clientY: number; target: Point } | null = null
    const onMouseDown = (e: MouseEvent) => {
      down = null
      walk++
      if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
        return
      }
      const screen = term.element?.querySelector('.xterm-screen')
      if (!screen || !applies()) return
      const r = screen.getBoundingClientRect()
      const cellW = r.width / term.cols
      const cellH = r.height / term.rows
      const row = Math.floor((e.clientY - r.top) / cellH)
      if (row < 0 || row >= term.rows) return
      // To the nearest gap between characters, where a caret can sit.
      const x = Math.max(0, Math.min(term.cols, Math.round((e.clientX - r.left) / cellW)))
      down = {
        clientX: e.clientX,
        clientY: e.clientY,
        target: { x, y: term.buffer.active.viewportY + row },
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      const click = down
      down = null
      if (!click || e.button !== 0) return
      // A drag is a selection, not a click.
      if (Math.hypot(e.clientX - click.clientX, e.clientY - click.clientY) > 3) return
      if (term.hasSelection()) return
      void moveTo(click.target)
    }
    const onKeyDown = () => {
      walk++
    }
    host.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp, true)
    host.addEventListener('keydown', onKeyDown, true)
    return () => {
      walk++
      host.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      host.removeEventListener('keydown', onKeyDown, true)
    }
  }, [tab.id, tab.kind, settings.terminal.clickMovesCursor])

  const lastRightClick = useRef(0)
  const onContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      if (!settings.terminal.rightClickPaste) return
      e.preventDefault()
      const term = termRef.current
      if (!term) return
      // A program that reads the mouse has been sent this click already —
      // xterm holds it back only with Shift, and never on macOS — and Claude
      // Code pastes on a right click itself: pasting here too typed it twice.
      const heldBack = e.shiftKey && platform() !== 'macos'
      if (term.modes.mouseTrackingMode !== 'none' && !heldBack) return
      // WebView2 can deliver one right click as two context-menu events;
      // a second paste a moment later is never what was meant.
      if (e.timeStamp - lastRightClick.current < 400) return
      lastRightClick.current = e.timeStamp
      const sel = term.getSelection()
      if (sel) {
        await navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        return
      }
      // Through xterm, like Ctrl+V: the program gets it as one paste —
      // bracketed when it asked for that — rather than as typed keys.
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text) term.paste(text)
    },
    [settings.terminal.rightClickPaste],
  )

  return (
    <div
      className="term" data-terminal-tab={tab.id} onContextMenu={onContextMenu}
      onMouseDown={claimSize}
    >
      {remoteSized && (
        <button className="term__remote" onClick={claimSize} title={t('remote.reclaimHint')}>
          <Smartphone size={12} />
          {t('remote.sizedForPhone')}
        </button>
      )}
      <PinnedBar
        pins={tab.pins ?? []}
        history={history}
        onShow={showPin}
        onPin={(text) => pinMessage(tab.id, text)}
        onUnpin={(id) => unpinMessage(tab.id, id)}
        onInsert={insertRequest}
      />
      <div ref={bodyRef} className="term__body">
        <div ref={hostRef} className="term__host" />
        {pinSpot && (() => {
          const on = !!pinned(pinSpot.text)
          const label = on
            ? t('pins.unpin')
            : pinSpot.selection ? t('pins.pinSelection') : t('pins.pin')
          return (
            <button
              className={`term__pin${on ? ' term__pin--on' : ''}`}
              style={{ top: pinSpot.y }}
              aria-label={label}
              title={label}
              // Keeps the focus, and the selection, in the terminal.
              onMouseDown={(e) => e.preventDefault()}
              onClick={togglePin}
            >
              <Pin size={13} />
            </button>
          )
        })()}
        {fileDropTarget && <div className="dropzone dropzone--center" aria-hidden />}
        {findOpen && (
          <div className="findbar">
            <input
              className="findbar__input"
              autoFocus
              value={findTerm}
              placeholder={t('find.placeholder')}
              onChange={(e) => {
                setFindTerm(e.target.value)
                runSearch(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(findTerm, e.shiftKey)
                if (e.key === 'Escape') closeFind()
              }}
            />
            <span className="findbar__count subtle">
              {findTerm
                ? findHits && findHits.count > 0
                  ? t('find.results', { i: findHits.index, n: findHits.count })
                  : t('find.noResults')
                : ''}
            </span>
            <button
              className="icon-btn icon-btn--tiny" aria-label={t('find.previous')}
              onClick={() => runSearch(findTerm, true)}
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="icon-btn icon-btn--tiny" aria-label={t('find.next')}
              onClick={() => runSearch(findTerm)}
            >
              <ArrowDown size={13} />
            </button>
            <button
              className="icon-btn icon-btn--tiny" aria-label={t('find.close')}
              onClick={closeFind}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

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
