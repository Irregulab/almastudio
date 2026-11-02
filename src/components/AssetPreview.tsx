import { useEffect, useRef, useState, type ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

import { allowPreview } from '../lib/ipc'
import { useT } from '../i18n'

export type AssetKind = 'image' | 'video' | 'audio' | 'pdf' | 'html'

/**
 * Files shown as they are, loaded straight from disk through the asset
 * protocol rather than copied over IPC: no size limit, and video can seek.
 *
 * `fallback` replaces the error when a file that cannot be shown is not worth
 * reporting, such as a deleted image in a diff. `active` is false while the tab
 * is out of sight, which must not leave a video playing behind it.
 */
export function AssetPreview({
  kind, path, version, active = true, fallback,
}: {
  kind: AssetKind
  path: string
  version: number
  active?: boolean
  fallback?: ReactNode
}) {
  const t = useT()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFailed(null)
    // Authorize only the selected file. The scope is shared by all webviews,
    // so allowing an HTML directory would let a remote browser tab probe every
    // file beneath it through image-load success/failure.
    void allowPreview(path)
      .then(() => !cancelled && setUrl(`${convertFileSrc(path)}?v=${version}`))
      .catch((e) => !cancelled && setFailed(String(e)))
    return () => {
      cancelled = true
    }
  }, [kind, path, version])

  if (failed) return fallback ?? <div className="empty">{failed}</div>
  if (!url) return <div className="empty">{t('common.loading')}</div>
  if (kind === 'image') return <ImagePreview src={url} fallback={fallback} />
  if (kind === 'video' || kind === 'audio') {
    return <MediaPreview kind={kind} src={url} active={active} fallback={fallback} />
  }
  if (kind === 'pdf') return <iframe className="preview-frame" src={url} title={path} />
  // An empty sandbox: the page is shown, not run — no scripts, forms,
  // pop-ups or navigating the app. Its own resources still load.
  return (
    <iframe className="preview-frame preview-frame--page" sandbox="" src={url} title={path} />
  )
}

/** An image on a checkerboard; clicking switches between fit and actual size. */
export function ImagePreview({ src, fallback }: { src: string; fallback?: ReactNode }) {
  const t = useT()
  const [fit, setFit] = useState(true)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => setBroken(false), [src])

  if (broken) return fallback ?? <div className="empty">{t('view.imageError')}</div>
  return (
    <div className="imgview">
      <div
        className={`imgview__stage${fit ? ' imgview__stage--fit' : ''}`}
        onClick={() => setFit((f) => !f)}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) =>
            setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          onError={() => setBroken(true)}
        />
      </div>
      <span className="imgview__info">
        {size && `${size.w} × ${size.h} · `}
        {fit ? t('view.fit') : t('view.actualSize')}
      </span>
    </div>
  )
}

/** Video and audio with the webview's own controls. */
function MediaPreview({
  kind, src, active, fallback,
}: { kind: 'video' | 'audio'; src: string; active: boolean; fallback?: ReactNode }) {
  const t = useT()
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setBroken(false)
    setSize(null)
  }, [src])

  // Tabs stay mounted while hidden, and a hidden element goes on playing.
  useEffect(() => {
    if (!active) ref.current?.pause()
  }, [active])

  // A detached element keeps playing until it is collected.
  useEffect(() => {
    const element = ref.current
    return () => element?.pause()
  }, [src])

  if (broken) return fallback ?? <div className="empty">{t('view.mediaError')}</div>
  const shared = {
    src,
    controls: true,
    preload: 'metadata',
    onError: () => setBroken(true),
  }
  return (
    <div className="mediaview">
      {kind === 'video' ? (
        <video
          {...shared}
          ref={ref}
          playsInline
          onLoadedMetadata={(e) =>
            setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
          }
        />
      ) : (
        <audio {...shared} ref={ref} />
      )}
      {size && size.w > 0 && <span className="imgview__info">{`${size.w} × ${size.h}`}</span>}
    </div>
  )
}
