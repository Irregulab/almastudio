import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, CornerDownLeft, History, Pin, X } from 'lucide-react'

import { useT } from '../i18n'
import { normalize } from '../lib/pinnedMessages'
import { relativeTime } from '../lib/time'
import type { PinnedMessage, SentPrompt } from '../lib/types'

interface Props {
  pins: PinnedMessage[]
  /** The requests sent from the tab, oldest first; none where they are not kept. */
  history: SentPrompt[]
  /** Shows the message in the terminal, paging to it when needed; false when it is no longer there. */
  onShow: (pin: PinnedMessage) => Promise<boolean>
  onPin: (text: string) => void
  onUnpin: (pinId: string) => void
  /** Puts a request back in the prompt, unsent. */
  onInsert: (text: string) => void
}

/** How long "no longer in the terminal" stays after a click that found nothing. */
const LOST_MS = 2000
/** How long a request's copy button says it was copied. */
const COPIED_MS = 1200

/** A request from the history, shown in the terminal as a pin would be. */
const asPin = (p: SentPrompt, i: number): PinnedMessage => ({ id: `sent-${p.at}-${i}`, text: p.text, at: p.at })

/**
 * Above a terminal: the latest message pinned to it in a line of its own,
 * with the others, and the requests sent from it, in lists that open over the
 * terminal — so opening one never resizes the terminal under the program
 * drawing in it.
 */
export function PinnedBar({ pins, history, onShow, onPin, onUnpin, onInsert }: Props) {
  const t = useT()
  const [open, setOpen] = useState<'pins' | 'history' | null>(null)
  const [query, setQuery] = useState('')
  const [lost, setLost] = useState<string | null>(null)
  /** The message being looked for, while the terminal is paged through. */
  const [seeking, setSeeking] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lostTimer = useRef<number | undefined>(undefined)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    window.clearTimeout(lostTimer.current)
    window.clearTimeout(copiedTimer.current)
  }, [])

  // A list closes on a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (pins.length < 2) setOpen((o) => (o === 'pins' ? null : o))
  }, [pins.length])

  /** The requests that match the search, newest first. */
  const matches = useMemo(() => {
    const want = normalize(query).toLocaleLowerCase()
    const all = history.map((p, i) => ({ prompt: p, pin: asPin(p, i) })).reverse()
    return want ? all.filter((m) => normalize(m.prompt.text).toLocaleLowerCase().includes(want)) : all
  }, [history, query])

  const latest = pins[pins.length - 1]
  if (!latest && !history.length) return null

  const show = async (pin: PinnedMessage) => {
    setOpen(null)
    setLost(null)
    setSeeking(pin.id)
    const found = await onShow(pin).catch(() => false)
    // A later click has taken over.
    setSeeking((s) => (s === pin.id ? null : s))
    if (found) return
    setLost(pin.id)
    window.clearTimeout(lostTimer.current)
    lostTimer.current = window.setTimeout(() => setLost(null), LOST_MS)
  }

  const pinOf = (text: string) => pins.find((p) => normalize(p.text) === normalize(text))
  const togglePin = (text: string) => {
    const pin = pinOf(text)
    if (pin) onUnpin(pin.id)
    else onPin(text)
  }

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
    }).catch(() => {})
  }

  const toggle = (list: 'pins' | 'history') => {
    if (list === 'history' && open !== 'history') setQuery('')
    setOpen((o) => (o === list ? null : list))
  }

  /**
   * How looking for a message is going — any one, as the list it was clicked
   * in has closed — or null when nothing is being looked for.
   */
  const status: ReactNode = seeking
    ? <span className="subtle">{t('pins.seeking')}</span>
    : lost
      ? <span className="subtle">{t('pins.lost')}</span>
      : null

  return (
    <div className="pinbar" ref={rootRef}>
      {latest ? (
        <>
          <Pin size={12} className="pinbar__icon" aria-hidden />
          <button
            className="pinbar__text"
            title={`${latest.text}\n\n${t('pins.show')}`}
            onClick={() => void show(latest)}
          >
            {status ?? latest.text}
          </button>
          {pins.length > 1 && (
            <button
              className="pinbar__count"
              aria-expanded={open === 'pins'}
              title={t('pins.all')}
              onClick={() => toggle('pins')}
            >
              {pins.length}
              <ChevronDown size={12} />
            </button>
          )}
          <button
            className="icon-btn icon-btn--tiny"
            aria-label={t('pins.unpin')}
            title={t('pins.unpin')}
            onClick={() => onUnpin(latest.id)}
          >
            <X size={12} />
          </button>
        </>
      ) : (
        // Nothing pinned: the line is the history's, and says how looking goes.
        <span className="pinbar__status">{status}</span>
      )}
      {!!history.length && (
        <button
          className="pinbar__count pinbar__history"
          aria-expanded={open === 'history'}
          title={t('history.title')}
          onClick={() => toggle('history')}
        >
          <History size={12} />
          {!latest && <span>{t('history.title')}</span>}
          {history.length}
          <ChevronDown size={12} />
        </button>
      )}

      {open === 'pins' && (
        <div className="pinbar__list" role="list">
          {[...pins].reverse().map((pin) => (
            <div key={pin.id} className="pinbar__item" role="listitem">
              <button
                className="pinbar__item-text"
                title={t('pins.show')}
                onClick={() => void show(pin)}
              >
                {pin.text}
              </button>
              <button
                className="icon-btn icon-btn--tiny"
                aria-label={t('pins.unpin')}
                title={t('pins.unpin')}
                onClick={() => onUnpin(pin.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {open === 'history' && (
        <div className="pinbar__list pinbar__list--history">
          <input
            className="input input--sm pinbar__search"
            autoFocus
            value={query}
            placeholder={t('history.search')}
            aria-label={t('history.search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) void show(matches[0].pin)
            }}
          />
          <div role="list">
            {matches.map(({ prompt, pin }) => {
              const pinned = !!pinOf(prompt.text)
              const pinLabel = pinned ? t('pins.unpin') : t('pins.pin')
              return (
                <div key={pin.id} className="pinbar__item" role="listitem">
                  <button className="pinbar__entry" title={t('pins.show')} onClick={() => void show(pin)}>
                    <span className="pinbar__entry-text">{prompt.text}</span>
                    <span className="pinbar__entry-time">{relativeTime(prompt.at / 1000)}</span>
                  </button>
                  <button
                    className={`icon-btn icon-btn--tiny${pinned ? ' icon-btn--on' : ''}`}
                    aria-label={pinLabel}
                    title={pinLabel}
                    onClick={() => togglePin(prompt.text)}
                  >
                    <Pin size={12} />
                  </button>
                  <button
                    className="icon-btn icon-btn--tiny"
                    aria-label={t('history.insert')}
                    title={t('history.insert')}
                    onClick={() => {
                      setOpen(null)
                      onInsert(prompt.text)
                    }}
                  >
                    <CornerDownLeft size={12} />
                  </button>
                  <button
                    className="icon-btn icon-btn--tiny"
                    aria-label={copied === pin.id ? t('history.copied') : t('history.copy')}
                    title={copied === pin.id ? t('history.copied') : t('history.copy')}
                    onClick={() => copy(pin.id, prompt.text)}
                  >
                    {copied === pin.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )
            })}
            {!matches.length && <p className="pinbar__empty subtle">{t('history.none')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
