import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { Download, RefreshCw } from 'lucide-react'

import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { Field, Modal, NumberInput, Toggle } from './ui'

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** `silent` when a background check found it, which is what prompts. */
  | { kind: 'available'; update: Update; silent: boolean }
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

/** When the last check finished, so a missed interval can be caught up on. */
let lastCheck = 0
/** The version the user answered "Later" to; it is not prompted again. */
let dismissed: string | null = null

export async function checkForUpdates(silent: boolean): Promise<void> {
  // Nothing to look for while one is being fetched, or installed and waiting
  // for the restart that finishes it.
  if (current.kind === 'checking' || current.kind === 'downloading') return
  if (silent && (current.kind === 'ready' || current.kind === 'installing')) return
  setPhase({ kind: 'checking' })
  try {
    const update = await check()
    if (update) setPhase({ kind: 'available', update, silent })
    else setPhase(silent ? { kind: 'idle' } : { kind: 'upToDate' })
  } catch (e) {
    // A background check has nowhere to show this, and a silent failure is
    // indistinguishable from "no update": leave it in the log at least.
    if (silent) {
      void invoke('log_frontend', {
        level: 'warn', message: `update check failed: ${e}`,
      }).catch(() => {})
    }
    setPhase(silent ? { kind: 'idle' } : { kind: 'error', message: String(e) })
  } finally {
    lastCheck = Date.now()
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

/**
 * Background check on launch and on an interval, and the prompts it leads to:
 * one offering the update it found, one asking to restart once it is in.
 */
export function UpdateWatcher() {
  const t = useT()
  const { autoCheck, intervalHours } = useSettings((s) => s.settings.updates)
  const phase = usePhase()
  const [hidden, setHidden] = useState<string | null>(dismissed)
  /** The install was started from the prompt, so it reports back there. */
  const [fromPrompt, setFromPrompt] = useState(false)

  useEffect(() => {
    if (!autoCheck) return
    const period = Math.max(1, intervalHours) * 3600_000
    const run = () => void checkForUpdates(true)
    // Wait for the window to settle before touching the network.
    const first = window.setTimeout(run, 8000)
    const every = window.setInterval(run, period)
    // Timers do not run while the machine sleeps, so a laptop closed overnight
    // would come back with the interval long overdue and nothing to fire it.
    const onFocus = () => {
      if (Date.now() - lastCheck >= period) run()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
      window.removeEventListener('focus', onFocus)
    }
  }, [autoCheck, intervalHours])

  // What a background check found: the user never opened Settings to ask, so
  // the offer has to come to them.
  if (phase.kind === 'available' && phase.silent && phase.update.version !== hidden) {
    const { update } = phase
    const later = () => {
      dismissed = update.version
      setHidden(update.version)
    }
    return (
      <Modal
        title={t('update.availableTitle')}
        onClose={later}
        footer={
          <>
            <button className="btn" onClick={later}>{t('update.later')}</button>
            <button
              className="btn btn--primary"
              onClick={() => {
                setFromPrompt(true)
                void installUpdate(update)
              }}
            >
              <Download size={13} /> {t('update.install')}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          {t('update.availableBody', { version: update.version, current: update.currentVersion })}
        </p>
        {update.body && <pre className="release-notes">{update.body}</pre>}
      </Modal>
    )
  }

  // Downloading is not instant and the prompt is gone by then; without this
  // the window would simply close on whoever asked for the update.
  if (fromPrompt && (phase.kind === 'downloading' || phase.kind === 'installing')) {
    return (
      <Modal title={t('update.availableTitle')} onClose={() => setFromPrompt(false)}>
        <p style={{ margin: 0 }}>
          {phase.kind === 'downloading'
            ? t('update.downloading', { percent: phase.percent })
            : t('update.installing')}
        </p>
      </Modal>
    )
  }

  if (fromPrompt && phase.kind === 'error') {
    return (
      <Modal
        title={t('update.availableTitle')}
        onClose={() => setFromPrompt(false)}
        footer={
          <button className="btn" onClick={() => setFromPrompt(false)}>{t('common.close')}</button>
        }
      >
        <p style={{ margin: 0 }}>{t('update.failed', { error: phase.message })}</p>
      </Modal>
    )
  }

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
