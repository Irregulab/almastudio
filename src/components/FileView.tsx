import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { Check, Code2, ExternalLink, Eye, RefreshCw, Save } from 'lucide-react'

import { GIT_CHANGED_EVENT } from '../hooks/useAutoFetch'
import { findConflicts } from '../lib/conflicts'
import { allowPreview, gitMarkResolved, readTextFile, writeTextFile } from '../lib/ipc'
import { languageOf, previewKindOf } from '../lib/syntax'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { CodeEditor } from './CodeEditor'
import { FileIcon } from './FileIcon'
import { ConfirmDialog, Segmented } from './ui'
import type { FileContent, FileTab } from '../lib/types'

type Mode = 'preview' | 'source'

export function FileView({ tab, visible }: { tab: FileTab; visible: boolean }) {
  const t = useT()
  const setTabDirty = useUi((s) => s.setTabDirty)
  const pinTab = useWorkspace((s) => s.pinTab)
  const [file, setFile] = useState<FileContent | null>(null)
  const [content, setContent] = useState('')
  /** What is on disk as far as we know; the basis for both dirty and conflict. */
  const [original, setOriginal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const kind = previewKindOf(tab.path)
  // Images and PDFs have no source worth showing; the rest toggle like Markdown.
  const viewOnly = kind === 'image' || kind === 'pdf'
  const [mode, setMode] = useState<Mode>(kind ? 'preview' : 'source')
  /** Bumped when the file changes, so previews that read it from disk reload. */
  const [version, setVersion] = useState(0)
  const seen = useRef<string | null>(null)

  const dirty = content !== original
  const editable = !!file && !file.binary && !file.truncated

  // A search result points at a line, which only the source shows.
  useEffect(() => {
    if (tab.reveal && kind && !viewOnly) setMode('source')
  }, [tab.reveal, kind, viewOnly])

  const conflicts = useMemo(() => (editable ? findConflicts(content).length : 0), [content, editable])
  const inConflict = conflicts > 0
  /** It had conflict markers, so it can be marked resolved once they are gone. */
  const [hadConflicts, setHadConflicts] = useState(false)
  useEffect(() => {
    if (!inConflict) return
    setHadConflicts(true)
    // Conflicts are resolved in the source.
    if (kind && !viewOnly) setMode('source')
  }, [inConflict, kind, viewOnly])

  const absolute =
    tab.path.startsWith('/') || /^[A-Za-z]:/.test(tab.path)
      ? tab.path
      : `${tab.root.replace(/\/+$/, '')}/${tab.path}`

  const load = useCallback(
    async (discardEdits = false, force = false) => {
      setLoading(true)
      try {
        const f = await readTextFile(absolute)
        setFile(f)
        // Reload disk-backed previews only when the file changed (or on an
        // explicit refresh), so coming back to the tab keeps a PDF's page.
        const signature = f.binary || f.truncated ? String(f.size) : f.content
        if (force || seen.current !== signature) setVersion((v) => v + 1)
        seen.current = signature
        setError(null)
        // Reloading must not silently throw away work in progress.
        setOriginal(f.content)
        setContent((prev) => (discardEdits || prev === '' ? f.content : prev))
      } catch (e) {
        setError(String(e))
        setFile(null)
      } finally {
        setLoading(false)
      }
    },
    [absolute],
  )

  useEffect(() => {
    if (visible) void load(false)
  }, [visible, load])

  useEffect(() => {
    setTabDirty(tab.id, dirty)
  }, [dirty, setTabDirty, tab.id])

  // An edited preview is kept, as in VS Code: the next preview must not close it.
  useEffect(() => {
    if (dirty && tab.preview) pinTab(tab.id)
  }, [dirty, tab.preview, tab.id, pinTab])

  // Clear the marker when the tab goes away, so it cannot outlive the editor.
  useEffect(() => () => setTabDirty(tab.id, false), [setTabDirty, tab.id])

  const write = useCallback(async () => {
    setSaving(true)
    try {
      await writeTextFile(absolute, content)
      setOriginal(content)
      seen.current = content
      setVersion((v) => v + 1)
      setNotice(t('editor.saved'))
      window.setTimeout(() => setNotice(null), 1800)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
      setConflict(null)
    }
  }, [absolute, content, t])

  const save = useCallback(async () => {
    if (!dirty || saving) return
    // Agents are editing these same files in the next tab along, so check what
    // is actually on disk before overwriting it.
    try {
      const onDisk = await readTextFile(absolute)
      if (!onDisk.binary && onDisk.content !== original) {
        setConflict(onDisk.content)
        return
      }
    } catch {
      // Unreadable now: fall through and let the write report the real error.
    }
    await write()
  }, [absolute, dirty, original, saving, write])

  const markResolved = async () => {
    try {
      await gitMarkResolved(absolute)
      setHadConflicts(false)
      setNotice(t('conflicts.resolved'))
      window.setTimeout(() => setNotice(null), 1800)
      window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT))
    } catch (e) {
      setError(String(e))
    }
  }

  const language = languageOf(tab.path)
  const showSource = !kind || (!viewOnly && mode === 'source')
  // An SVG being edited is drawn from the editor's text instead (see below).
  const assetKind =
    kind === 'svg' ? 'image' : kind === 'image' || kind === 'pdf' || kind === 'html' ? kind : null
  return (
    <div className="diff">
      <div className="diff__bar">
        <FileIcon name={tab.path.split('/').pop() ?? tab.path} size={13} />
        <span className="diff__path truncate mono" title={absolute}>
          {tab.path}
          {dirty && <span className="diff__dirty" aria-label={t('editor.unsaved')}>●</span>}
        </span>
        {language && <span className="chip">{language}</span>}
        {file && <span className="chip">{formatBytes(file.size)}</span>}
        {notice && <span className="chip chip--ok">{notice}</span>}
        {inConflict && <span className="chip chip--dirty">{t('conflicts.count', { n: conflicts })}</span>}
        {hadConflicts && !inConflict && !dirty && (
          <button className="btn btn--sm btn--primary" onClick={() => void markResolved()}>
            <Check size={12} /> {t('conflicts.markResolved')}
          </button>
        )}
        {kind === 'html' && !showSource && (
          <>
            <span className="chip">{t('view.noScripts')}</span>
            {dirty && <span className="chip">{t('view.savedOnly')}</span>}
          </>
        )}
        <span className="spacer" />
        {kind && !viewOnly && (
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'preview', label: t('view.preview'), icon: <Eye size={12} /> },
              { value: 'source', label: t('view.source'), icon: <Code2 size={12} /> },
            ]}
          />
        )}
        {editable && showSource && (
          <button
            className="btn btn--sm btn--primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <Save size={12} /> {t('editor.save')}
          </button>
        )}
        {editable && showSource && dirty && (
          <button className="btn btn--sm" onClick={() => setContent(original)}>
            {t('editor.revert')}
          </button>
        )}
        <button className="icon-btn" onClick={() => void load(!dirty, true)} aria-label={t('panel.refresh')}>
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('diff.revealFile')}
          onClick={() => void revealItemInDir(absolute).catch(() => {})}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      <div className="diff__body">
        {error && <div className="empty">{error}</div>}
        {showSource ? (
          <>
            {file?.binary && <div className="empty">{t('diff.binary')}</div>}
            {file?.truncated && <div className="empty">{t('diff.truncated')}</div>}
            {editable && (
              <CodeEditor
                value={content}
                path={tab.path}
                reveal={tab.reveal}
                conflictLabels={{
                  current: t('conflicts.acceptCurrent'),
                  incoming: t('conflicts.acceptIncoming'),
                  both: t('conflicts.acceptBoth'),
                }}
                onChange={setContent}
                onSave={() => void save()}
              />
            )}
          </>
        ) : kind === 'markdown' ? (
          editable ? (
            <MarkdownPreview source={content} path={absolute} root={tab.root} />
          ) : (
            file?.truncated && <div className="empty">{t('diff.truncated')}</div>
          )
        ) : kind === 'svg' && editable ? (
          // From the editor's text, so the preview follows unsaved edits.
          <ImagePreview src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`} />
        ) : (
          assetKind && !error && (
            <AssetPreview kind={assetKind} path={absolute} version={version} />
          )
        )}
      </div>

      {conflict !== null && (
        <ConfirmDialog
          title={t('editor.conflictTitle')}
          message={t('editor.conflictBody')}
          confirmLabel={t('editor.overwrite')}
          danger
          onCancel={() => {
            // Take what is on disk and drop our edits.
            setOriginal(conflict)
            setContent(conflict)
            setConflict(null)
          }}
          onConfirm={() => void write()}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------- markdown ---

function MarkdownPreview({ source, path, root }: { source: string; path: string; root: string }) {
  const t = useT()
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setFailed(false)
    void import('../lib/markdown')
      .then(({ renderMarkdown }) => renderMarkdown(source))
      .then(async (r) => {
        const document = new DOMParser().parseFromString(`<div>${r.html}</div>`, 'text/html')
        const images = [...document.body.firstElementChild!.querySelectorAll('img[src]')]
        await Promise.all(images.map(async (image) => {
          const src = image.getAttribute('src')
          const localPath = src ? resolveMarkdownImage(path, src, root) : null
          if (!localPath) return
          try {
            await allowPreview(localPath)
            image.setAttribute('src', convertFileSrc(localPath))
          } catch {
            // Leave an unavailable local image untouched; the browser's
            // broken-image state is preferable to failing the whole preview.
          }
        }))
        return document.body.firstElementChild!.innerHTML
      })
      .then((html) => !cancelled && setHtml(html))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [path, root, source])

  // Links in a document must not navigate the app's own webview away.
  const onClick = useCallback((e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href')
    if (href && /^https?:/i.test(href)) void openUrl(href).catch(() => {})
  }, [])

  if (failed) return <div className="empty">{t('common.error')}</div>
  if (html === null) return <div className="empty">{t('common.loading')}</div>

  return (
    <div
      ref={ref}
      className="md"
      onClick={onClick}
      // Sanitised by DOMPurify in renderMarkdown before it reaches here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Resolve a Markdown image against the document it belongs to. */
function resolveMarkdownImage(documentPath: string, source: string, root: string): string | null {
  // Keep remote, data and fragment URLs under the normal browser handling.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return null

  const clean = source.split(/[?#]/, 1)[0]
  if (!clean) return null
  const base = documentPath.replace(/[/\\][^/\\]*$/, '')
  const initial = clean.startsWith('/') ? [] : base.split(/[\\/]/)
  const parts = [...initial]

  for (const raw of clean.replaceAll('\\', '/').split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    try {
      parts.push(decodeURIComponent(raw))
    } catch {
      parts.push(raw)
    }
  }

  const resolved = parts.join('/')
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '')
  const normalizedResolved = (clean.startsWith('/') ? `/${resolved}` : resolved)
    .replaceAll('\\', '/')
  const rootKey = /^[A-Za-z]:\//.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot
  const resolvedKey = /^[A-Za-z]:\//.test(normalizedResolved)
    ? normalizedResolved.toLowerCase()
    : normalizedResolved
  if (resolvedKey !== rootKey && !resolvedKey.startsWith(`${rootKey}/`)) return null
  return normalizedResolved
}

// ---------------------------------------------------- images, pdf, html ---

/**
 * Images, PDFs and HTML pages, loaded straight from disk through the asset
 * protocol rather than copied over IPC: no size limit.
 */
function AssetPreview({
  kind, path, version,
}: { kind: 'image' | 'pdf' | 'html'; path: string; version: number }) {
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

  if (failed) return <div className="empty">{failed}</div>
  if (!url) return <div className="empty">{t('common.loading')}</div>
  if (kind === 'image') return <ImagePreview src={url} />
  if (kind === 'pdf') return <iframe className="preview-frame" src={url} title={path} />
  // An empty sandbox: the page is shown, not run — no scripts, forms,
  // pop-ups or navigating the app. Its own resources still load.
  return (
    <iframe className="preview-frame preview-frame--page" sandbox="" src={url} title={path} />
  )
}

/** An image on a checkerboard; clicking switches between fit and actual size. */
function ImagePreview({ src }: { src: string }) {
  const t = useT()
  const [fit, setFit] = useState(true)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => setBroken(false), [src])

  if (broken) return <div className="empty">{t('view.imageError')}</div>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
