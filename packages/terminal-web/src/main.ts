/**
 * The terminal page the companion app shows in a WebView: xterm.js, the same
 * renderer as the desktop, driven over postMessage.
 *
 *   app → page   window.T.<method>(…) through injectJavaScript
 *   page → app   ReactNativeWebView.postMessage(JSON)
 *                { t: 'ready' } | { t: 'size', cols, rows } | { t: 'data', data }
 *                | { t: 'text', text } | { t: 'tap' }
 *                | { t: 'choice', choice: { options, selected } | null }
 *
 * Built into one inline HTML string by scripts/build-terminal-web.mjs.
 */

import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import './page.css'
import { findChoice } from './choice'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (msg: string) => void }
    T: typeof api
  }
}

type FitMode = 'phone' | 'desktop'

const post = (msg: unknown) => window.ReactNativeWebView?.postMessage(JSON.stringify(msg))

const host = document.getElementById('term')!
let baseFontSize = 13
let fitMode: FitMode = 'phone'
let desktopCols = 120

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: "Menlo, 'SF Mono', 'Roboto Mono', 'Droid Sans Mono', monospace",
  fontSize: baseFontSize,
  lineHeight: 1.15,
  scrollback: 5000,
  // The phone's own text field handles autocorrect and dictation; the page
  // only sees what the user actually typed.
  screenReaderMode: false,
})
const fit = new FitAddon()
term.loadAddon(fit)
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
term.open(host)

const textarea = host.querySelector('textarea')
if (textarea) {
  // Keep the soft keyboard from rewriting what is typed into a shell.
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('spellcheck', 'false')
}

/**
 * Answers the terminal gives on its own — to a program asking for the
 * device attributes, the cursor position or the colours, and focus reports.
 * The desktop's terminal already answers those; a second answer from here
 * would reach the program as typed input.
 */
const AUTOMATIC = /^(?:\x1b\[[?>=]?[\d;]*[cnRy]|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/

term.onData((data) => {
  if (AUTOMATIC.test(data)) return
  post({ t: 'data', data })
})

let lastSize = ''
function report() {
  const size = `${term.cols}x${term.rows}`
  if (size === lastSize) return
  lastSize = size
  post({ t: 'size', cols: term.cols, rows: term.rows })
}

function layout() {
  if (host.clientWidth === 0 || host.clientHeight === 0) return
  if (fitMode === 'phone') {
    if (term.options.fontSize !== baseFontSize) term.options.fontSize = baseFontSize
    try {
      fit.fit()
    } catch {
      /* not laid out yet */
    }
  } else {
    // Show the desktop's width whole: shrink the font until its columns fit.
    term.options.fontSize = baseFontSize
    const proposed = fit.proposeDimensions()
    if (!proposed) return
    const size = Math.max(4, Math.floor(baseFontSize * (proposed.cols / desktopCols) * 10) / 10)
    term.options.fontSize = size
    const rows = fit.proposeDimensions()?.rows ?? term.rows
    term.resize(desktopCols, Math.max(2, rows))
  }
  report()
}

new ResizeObserver(() => layout()).observe(host)

// Touch scrolling, which xterm does not do by itself. Over the scrollback
// the page scrolls it; on the alternate screen, or for a program that reads
// the mouse — an agent's full-screen UI — there is no scrollback to move, so
// the swipe goes to xterm as wheel turns: it reports them to the program, or
// sends arrow keys, as a mouse wheel on the desktop would.
let touchY: number | null = null
let touchX = 0
let moved = false
let carry = 0

function wheel(lines: number) {
  const target = host.querySelector('.xterm-screen') ?? host
  const step = lines > 0 ? 1 : -1
  for (let i = 0; i < Math.abs(lines); i++) {
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaY: step,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: touchX,
      clientY: touchY ?? 0,
      bubbles: true,
      cancelable: true,
    }))
  }
}

host.addEventListener('touchstart', (e) => {
  touchY = e.touches[0].clientY
  touchX = e.touches[0].clientX
  moved = false
  carry = 0
}, { passive: true, capture: true })
host.addEventListener('touchmove', (e) => {
  if (touchY === null) return
  const y = e.touches[0].clientY
  const lineHeight = (term.options.fontSize ?? 13) * 1.15
  carry += touchY - y
  touchY = y
  const lines = Math.trunc(carry / lineHeight)
  if (lines !== 0) {
    moved = true
    carry -= lines * lineHeight
    const app = term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
    if (app) wheel(lines)
    else term.scrollLines(lines)
  }
  e.preventDefault()
}, { passive: false, capture: true })
host.addEventListener('touchend', () => {
  if (!moved) post({ t: 'tap' })
  touchY = null
}, { capture: true })

function screenLines(): string[] {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < term.rows; i++) lines.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? '')
  return lines
}

let lastChoice = 'null'
let choiceTimer: ReturnType<typeof setTimeout> | null = null
function checkChoice() {
  if (choiceTimer) return
  choiceTimer = setTimeout(() => {
    choiceTimer = null
    const choice = findChoice(screenLines())
    const key = JSON.stringify(choice)
    if (key === lastChoice) return
    lastChoice = key
    post({ t: 'choice', choice })
  }, 120)
}
term.onWriteParsed(checkChoice)
term.onResize(checkChoice)

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const api = {
  /** Writes output, leaving out its first `skip` bytes — already shown. */
  write(b64: string, skip = 0) {
    const bytes = decode(b64)
    term.write(skip > 0 ? bytes.subarray(skip) : bytes)
  },
  writeText(text: string) {
    term.write(text)
  },
  reset() {
    term.reset()
    checkChoice()
  },
  setTheme(theme: ITheme, background: string) {
    term.options.theme = theme
    document.documentElement.style.background = background
    document.body.style.background = background
  },
  setFontSize(size: number) {
    baseFontSize = size
    layout()
  },
  setFitMode(mode: FitMode, cols: number) {
    fitMode = mode
    if (cols > 0) desktopCols = cols
    layout()
  },
  focus() {
    term.focus()
  },
  blur() {
    term.blur()
  },
  paste(text: string) {
    term.paste(text)
  },
  scrollToBottom() {
    term.scrollToBottom()
  },
  /** The screen and scrollback as plain text, for copying. */
  copyAll() {
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    post({ t: 'text', text: lines.join('\n') })
  },
}

window.T = api
layout()
post({ t: 'ready' })
