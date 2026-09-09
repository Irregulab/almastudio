import { useCallback, useEffect, useRef, useState } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { Download, RefreshCw } from 'lucide-react'

import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { Field, Modal, NumberInput, Toggle } from './ui'

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; percent: number }
  | { kind: 'installing' }
  | { kind: 'ready'; version: string }
  | { kind: 'upToDate' }
  | { kind: 'error'; message: string }

/** Shared updater state so the menu item and the settings pane agree. */
let listeners: Array<(p: Phase) => void> = []
let current: Phase = { kind: 'idle' }

function setPhase(p: Phase) {
  current = p
  for (const l of listeners) l(p)
}

function usePhase(): Phase {
  const [phase, setLocal] = useState(current)
  useEffect(() => {
    listeners.push(setLocal)
    return () => {
      listeners = listeners.filter((l) => l !== setLocal)
    }
  }, [])
  return phase
}

export async function checkForUpdates(silent: boolean): Promise<void> {
  if (current.kind === 'checking' || current.kind === 'downloading') return
  setPhase({ kind: 'checking' })
  try {
    const update = await check()
    if (update) setPhase({ kind: 'available', update })
    else setPhase(silent ? { kind: 'idle' } : { kind: 'upToDate' })
  } catch (e) {
    setPhase(silent ? { kind: 'idle' } : { kind: 'error', message: String(e) })
  }
}

async function installUpdate(update: Update) {
  let total = 0
  let received = 0
  setPhase({ kind: 'downloading', percent: 0 })
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? 0
          break
        case 'Progress':
          received += event.data.chunkLength
          setPhase({
            kind: 'downloading',
            percent: total ? Math.round((received / total) * 100) : 0,
          })
          break
        case 'Finished':
          setPhase({ kind: 'installing' })
          break
      }
    })
    setPhase({ kind: 'ready', version: update.version })
  } catch (e) {
    setPhase({ kind: 'error', message: String(e) })
  }
}

/** Background check on launch and on an interval, plus the "ready" prompt. */
export function UpdateWatcher() {
  const t = useT()
  const { autoCheck, intervalHours } = useSettings((s) => s.settings.updates)
  const phase = usePhase()
  const started = useRef(false)

  useEffect(() => {
    if (!autoCheck) return
    // Wait for the window to settle before touching the network.
    const first = window.setTimeout(() => void checkForUpdates(true), 8000)
    const every = window.setInterval(
      () => void checkForUpdates(true),
      Math.max(1, intervalHours) * 3600_000,
    )
    started.current = true
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
    }
  }, [autoCheck, intervalHours])

  if (phase.kind === 'ready') {
    return (
      <Modal
        title={t('update.readyTitle')}
        onClose={() => setPhase({ kind: 'idle' })}
        footer={
          <>
            <button className="btn" onClick={() => setPhase({ kind: 'idle' })}>
              {t('update.later')}
            </button>
            <button className="btn btn--primary" onClick={() => void relaunch()}>
              {t('update.restart')}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('update.readyBody', { version: phase.version })}</p>
      </Modal>
    )
  }
  return null
}

/** The Updates page of the Settings panel. */
export function UpdateSection() {
  const t = useT()
  const s = useSettings((x) => x.settings)
  const patch = useSettings((x) => x.patch)
  const phase = usePhase()

  const label = useCallback(() => {
    switch (phase.kind) {
      case 'checking': return t('update.checking')
      case 'available': return t('update.available', { version: phase.update.version })
      case 'downloading': return t('update.downloading', { percent: phase.percent })
      case 'installing': return t('update.installing')
      case 'ready': return t('update.readyBody', { version: phase.version })
      case 'upToDate': return t('update.upToDate')
      case 'error': return t('update.failed', { error: phase.message })
      default: return ''
    }
  }, [phase, t])

  return (
    <>
      <Field label={t('settings.autoCheck')} row>
        <Toggle
          checked={s.updates.autoCheck}
          onChange={(v) => patch('updates', { autoCheck: v })}
        />
      </Field>

      <Field label={t('settings.interval')}>
        <NumberInput
          value={s.updates.intervalHours} min={1} max={168}
          onChange={(v) => patch('updates', { intervalHours: v })} suffix="h"
        />
      </Field>

      <div className="row" style={{ marginTop: 4 }}>
        <button
          className="btn"
          disabled={phase.kind === 'checking' || phase.kind === 'downloading'}
          onClick={() => void checkForUpdates(false)}
        >
          <RefreshCw size={13} className={phase.kind === 'checking' ? 'spin' : undefined} />
          {t('settings.checkNow')}
        </button>
        {phase.kind === 'available' && (
          <button className="btn btn--primary" onClick={() => void installUpdate(phase.update)}>
            <Download size={13} /> {t('update.install')}
          </button>
        )}
        {phase.kind === 'ready' && (
          <button className="btn btn--primary" onClick={() => void relaunch()}>
            {t('update.restart')}
          </button>
        )}
      </div>

      {label() && <p className="field__hint" style={{ marginTop: 10 }}>{label()}</p>}

      {phase.kind === 'available' && phase.update.body && (
        <>
          <div className="settings__sep" />
          <div className="field__label">{t('update.notes')}</div>
          <pre className="release-notes">{phase.update.body}</pre>
        </>
      )}
    </>
  )
}
