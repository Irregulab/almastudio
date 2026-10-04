import { useCallback, useEffect, useState } from 'react'
import { Smartphone, Tablet } from 'lucide-react'

import {
  remotePairing, remotePairRespond, remoteRevoke, type PairingInfo, type RemoteDevice,
} from '../lib/ipc'
import { useRemote } from '../store/remote'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { ConfirmDialog, Field, Modal, NumberInput, TextInput, Toggle } from './ui'

/** Settings → Companion app. */
export function RemoteSection() {
  const t = useT()
  const s = useSettings((x) => x.settings.remote)
  const patch = useSettings((x) => x.patch)
  const status = useRemote((x) => x.status)
  const [pairing, setPairing] = useState(false)
  const [revoke, setRevoke] = useState<RemoteDevice | null>(null)

  const connected = new Set(status?.clients.map((c) => c.deviceKey) ?? [])

  return (
    <>
      <p className="subtle" style={{ marginTop: 0, lineHeight: 1.6 }}>{t('remote.intro')}</p>

      <Field label={t('remote.enable')} hint={t('remote.enableHint')} row>
        <Toggle checked={s.enabled} onChange={(v) => patch('remote', { enabled: v })} />
      </Field>

      {s.enabled && (
        <div className="remote__status">
          {status?.error ? (
            <span className="remote__error">{t('remote.error', { error: status.error })}</span>
          ) : status?.running ? (
            <span>
              {t('remote.listening', {
                where: status.addresses.length
                  ? status.addresses.map((a) => `${a}:${status.port}`).join(', ')
                  : `:${status.port}`,
              })}
            </span>
          ) : (
            <span className="subtle">{t('remote.starting')}</span>
          )}
          {status?.relay && (
            <span className={status.relay.connected ? '' : 'remote__error'}>
              {status.relay.connected
                ? t('remote.relayConnected')
                : t('remote.relayOffline', { error: status.relay.error ?? '…' })}
            </span>
          )}
        </div>
      )}

      <Field label={t('remote.port')} hint={t('remote.portHint')}>
        <NumberInput
          value={s.port} min={1024} max={65535}
          onChange={(v) => patch('remote', { port: v })}
        />
      </Field>

      <Field label={t('remote.relay')} hint={t('remote.relayHint')} row>
        <Toggle checked={s.relay} onChange={(v) => patch('remote', { relay: v })} />
      </Field>
      {s.relay && (
        <Field label={t('remote.relayUrl')}>
          <TextInput mono value={s.relayUrl} onCommit={(v) => patch('remote', { relayUrl: v.trim() })} />
        </Field>
      )}

      <Field label={t('remote.notify')} hint={t('remote.notifyHint')} row>
        <Toggle checked={s.notify} onChange={(v) => patch('remote', { notify: v })} />
      </Field>
      <Field label={t('remote.hideNames')} hint={t('remote.hideNamesHint')} row>
        <Toggle checked={s.hideNames} onChange={(v) => patch('remote', { hideNames: v })} />
      </Field>

      <div className="remote__devices">
        <div className="remote__devices-head">
          <span className="field__label">{t('remote.devices')}</span>
          <span className="spacer" />
          <button
            className="btn btn--primary btn--sm"
            disabled={!s.enabled || !status?.running}
            onClick={() => setPairing(true)}
          >
            {t('remote.pair')}
          </button>
        </div>
        {(status?.devices.length ?? 0) === 0 ? (
          <div className="subtle">{t('remote.noDevices')}</div>
        ) : (
          <ul className="remote__list">
            {status!.devices.map((d) => (
              <li key={d.key} className="remote__device">
                {/ipad|tablet|tab /i.test(d.name) ? <Tablet size={15} /> : <Smartphone size={15} />}
                <div className="remote__device-text">
                  <div className="truncate">{d.name || t('remote.unnamed')}</div>
                  <div className="subtle">
                    {connected.has(d.key)
                      ? t('remote.connectedNow')
                      : t('remote.lastSeen', { when: new Date(d.lastSeen).toLocaleString() })}
                  </div>
                </div>
                <button className="btn btn--sm btn--danger" onClick={() => setRevoke(d)}>
                  {t('remote.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pairing && <PairingDialog onClose={() => setPairing(false)} />}
      {revoke && (
        <ConfirmDialog
          title={t('remote.revoke')}
          message={t('remote.revokeConfirm', { name: revoke.name || t('remote.unnamed') })}
          danger confirmLabel={t('remote.revoke')}
          onCancel={() => setRevoke(null)}
          onConfirm={() => {
            void remoteRevoke(revoke.key).catch(() => {})
            setRevoke(null)
          }}
        />
      )}
    </>
  )
}

/** Shows a fresh pairing QR code, renewed when it expires. */
function PairingDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const relay = useSettings((x) => (x.settings.remote.relay ? x.settings.remote.relayUrl : null))
  const devices = useRemote((x) => x.status?.devices.length ?? 0)
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const issue = useCallback(() => {
    remotePairing(relay).then(setInfo, (e) => setError(String(e)))
  }, [relay])

  useEffect(issue, [issue])
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (info && now > info.expiresAt) issue()
  }, [info, now, issue])

  // A device was added: the job is done.
  const [initial] = useState(devices)
  useEffect(() => {
    if (devices > initial) onClose()
  }, [devices, initial, onClose])

  const left = info ? Math.max(0, Math.round((info.expiresAt - now) / 1000)) : 0

  return (
    <Modal title={t('remote.pairTitle')} onClose={onClose}>
      <div className="remote__pairing">
        {error ? (
          <div className="remote__error">{error}</div>
        ) : info ? (
          <>
            <div className="remote__qr" dangerouslySetInnerHTML={{ __html: info.svg }} />
            <p className="subtle">{t('remote.pairHint')}</p>
            <p className="subtle">
              {t('remote.pairExpires', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/** "Allow this device?" — one dialog per waiting request. */
export function PairRequestDialog() {
  const t = useT()
  const request = useRemote((x) => x.pairRequests[0])
  const remove = useRemote((x) => x.removePairRequest)
  if (!request) return null
  const answer = (accept: boolean) => {
    void remotePairRespond(request.requestId, accept).catch(() => {})
    remove(request.requestId)
  }
  return (
    <ConfirmDialog
      title={t('remote.allowTitle')}
      message={t('remote.allowMessage', { name: request.name || t('remote.unnamed') })}
      confirmLabel={t('remote.allow')}
      onCancel={() => answer(false)}
      onConfirm={() => answer(true)}
    />
  )
}

const NO_CLIENTS: never[] = []

/** Title-bar badge while devices are connected. */
export function RemoteIndicator() {
  const t = useT()
  const clients = useRemote((x) => x.status?.clients ?? NO_CLIENTS)
  if (clients.length === 0) return null
  const names = [...new Set(clients.map((c) => c.name || t('remote.unnamed')))].join(', ')
  return (
    <span className="remote__badge" title={t('remote.connectedDevices', { names })}>
      <Smartphone size={13} />
      {clients.length > 1 && <span>{clients.length}</span>}
    </span>
  )
}
