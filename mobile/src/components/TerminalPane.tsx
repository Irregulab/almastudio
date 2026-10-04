import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { AppState, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import * as Clipboard from 'expo-clipboard'

import type { RemoteConnection } from '@almastudio/protocol/src/client'
import type { Owner } from '@almastudio/protocol'
import { TERMINAL_HTML } from '../terminal/terminalHtml'
import { terminalTheme, usePalette } from '../lib/theme'
import type { Prefs } from '../lib/storage'

export interface TerminalHandle {
  /** Sends input as if typed, taking the size for this screen if needed. */
  send: (data: string) => void
  /** Pastes as the terminal would: bracketed when the program asked for it. */
  paste: (text: string) => void
  focus: () => void
  blur: () => void
  copyAll: () => void
}

interface Props {
  conn: RemoteConnection
  tabId: string
  prefs: Prefs
  /** Sticky Ctrl from the key bar: the next character typed is a control key. */
  ctrl: boolean
  onCtrlUsed: () => void
  /** The session is running; otherwise its last output is shown. */
  onState: (s: { alive: boolean; exitCode: number }) => void
}

/** Bytes in a base64 string, without decoding it. */
function b64Length(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length * 3) / 4 - pad
}

/**
 * One desktop terminal, shown live: attaches to the tab, replays its
 * scrollback, then streams its output into xterm.js in a WebView.
 */
export const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane(
  { conn, tabId, prefs, ctrl, onCtrlUsed, onState },
  ref,
) {
  const palette = usePalette()
  const isDark = useColorScheme() !== 'light'
  const web = useRef<WebView>(null)
  const [ready, setReady] = useState(false)
  const [owner, setOwner] = useState<Owner | null>(null)
  const size = useRef<{ cols: number; rows: number } | null>(null)
  const attached = useRef(false)
  const alive = useRef(false)
  const ctrlRef = useRef(ctrl)
  ctrlRef.current = ctrl
  const queue = useRef<string[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Batches calls into the page: one bridge crossing per frame at most. */
  const run = useCallback((js: string) => {
    queue.current.push(js)
    if (flushTimer.current) return
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      const script = queue.current.join(';')
      queue.current = []
      web.current?.injectJavaScript(`${script};true;`)
    }, 16)
  }, [])

  const claimSize = useCallback(() => {
    if (prefs.fitMode !== 'phone' || !attached.current || !alive.current || !size.current) return
    if (AppState.currentState !== 'active') return
    void conn.request('term.resize', { tabId, ...size.current }).catch(() => {})
  }, [conn, prefs.fitMode, tabId])

  const send = useCallback(
    (data: string) => {
      if (prefs.fitMode === 'phone' && owner && !owner.mine) claimSize()
      void conn.request('term.input', { tabId, data }).catch(() => {})
    },
    [claimSize, conn, owner, prefs.fitMode, tabId],
  )

  useImperativeHandle(ref, () => ({
    send,
    paste: (text: string) => run(`T.paste(${JSON.stringify(text)})`),
    focus: () => run('T.focus()'),
    blur: () => run('T.blur()'),
    copyAll: () => run('T.copyAll()'),
  }), [run, send])

  // Look and font follow the app's settings.
  useEffect(() => {
    if (!ready) return
    run(`T.setTheme(${JSON.stringify(terminalTheme(palette, isDark))}, ${JSON.stringify(palette.termBg)})`)
    run(`T.setFontSize(${prefs.fontSize})`)
  }, [isDark, palette, prefs.fontSize, ready, run])

  // Attach to the tab; detach — which gives the size back — when leaving it.
  useEffect(() => {
    if (!ready) return
    let live = true
    let writtenTo = 0
    attached.current = false
    alive.current = false
    setOwner(null)
    run('T.reset()')

    const offData = conn.on('term.data', (d) => {
      // Anything before the snapshot is already in it.
      if (d.tabId !== tabId || !attached.current) return
      const n = b64Length(d.b64)
      if (d.end <= writtenTo) return
      const start = d.end - n
      const skip = start < writtenTo ? writtenTo - start : 0
      writtenTo = d.end
      run(`T.write(${JSON.stringify(d.b64)},${skip})`)
    })
    const offExit = conn.on('term.exit', (d) => {
      if (d.tabId !== tabId) return
      alive.current = false
      onState({ alive: false, exitCode: d.code })
    })
    const offOwner = conn.on('term.owner', (o) => {
      if (o.tabId === tabId) setOwner({ remote: o.remote, mine: o.mine })
    })

    void conn.request('term.attach', { tabId }).then((snap) => {
      if (!live) return
      run(`T.write(${JSON.stringify(snap.b64)},0)`)
      run('T.scrollToBottom()')
      writtenTo = snap.live ? snap.end : 0
      attached.current = true
      alive.current = snap.alive
      setOwner(snap.owner)
      onState({ alive: snap.alive, exitCode: snap.exitCode })
      const cols = snap.desktopSize?.cols ?? 0
      run(`T.setFitMode(${JSON.stringify(prefs.fitMode)}, ${cols})`)
      claimSize()
    }).catch(() => {})

    return () => {
      live = false
      attached.current = false
      offData()
      offExit()
      offOwner()
      void conn.request('term.detach', { tabId }).catch(() => {})
    }
    // Re-attached only for another tab, connection or fit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, tabId, ready, prefs.fitMode])

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: { t: string; [k: string]: unknown }
      try {
        msg = JSON.parse(e.nativeEvent.data)
      } catch {
        return
      }
      switch (msg.t) {
        case 'ready':
          setReady(true)
          break
        case 'size':
          size.current = { cols: msg.cols as number, rows: msg.rows as number }
          claimSize()
          break
        case 'data': {
          let data = msg.data as string
          if (ctrlRef.current && data.length === 1) {
            const code = data.toUpperCase().charCodeAt(0)
            if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
            onCtrlUsed()
          }
          send(data)
          break
        }
        case 'text':
          void Clipboard.setStringAsync(msg.text as string)
          break
        case 'tap':
          run('T.focus()')
          break
      }
    },
    [claimSize, onCtrlUsed, run, send],
  )

  const sizedElsewhere = prefs.fitMode === 'phone' && owner && !owner.mine && alive.current

  return (
    <View style={[styles.wrap, { backgroundColor: palette.termBg }]}>
      <WebView
        ref={web}
        originWhitelist={['*']}
        source={{ html: TERMINAL_HTML }}
        onMessage={onMessage}
        style={{ backgroundColor: palette.termBg }}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        textInteractionEnabled={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        javaScriptEnabled
      />
      {sizedElsewhere && (
        <Pressable
          style={[styles.banner, { backgroundColor: palette.raised, borderColor: palette.border }]}
          onPress={claimSize}
        >
          <Text style={{ color: palette.muted, fontSize: 12 }}>
            {owner?.remote ? 'Sized for another device' : 'In use on the desktop'} · tap to fit here
          </Text>
        </Pressable>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
