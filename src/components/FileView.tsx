import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  ArrowDown, ArrowUp, Check, Code2, ExternalLink, Eye, RefreshCw, Save, Search, WrapText, X,
} from 'lucide-react'

import { GIT_CHANGED_EVENT } from '../hooks/useAutoFetch'
import { useFileChanges } from '../hooks/useFileChanges'
import { findConflicts } from '../lib/conflicts'
import { applyEdit, followDisk, type FileBuffer } from '../lib/fileBuffer'
import { findRanges } from '../lib/findText'
import { allowPreview, gitMarkResolved, readTextFile, readTextHead, writeTextFile } from '../lib/ipc'
import { languageOf, previewKindOf } from '../lib/syntax'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { CodeEditor } from './CodeEditor'
import { FileIcon } from './FileIcon'
import { ConfirmDialog, Segmented } from './ui'
import type { FileContent, FileTab } from '../lib/types'

type Mode = 'preview' | 'source'

export function FileView({ tab, visible, focused }: { tab: FileTab; visible: boolean; focused: boolean }) {
  const t = useT()
  const setTabDirty = useUi((s) => s.setTabDirty)
  const pinTab = useWorkspace((s) => s.pinTab)
  const [file, setFile] = useState<FileContent | null>(null)
  /** One state, so a read from disk sees the edits as they are when it lands. */
  const [buffer, setBuffer] = useState<FileBuffer>({ content: '', original: '' })
  const { content, original } = buffer
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
  /** Reads overlap now the watcher starts them too; only the newest counts. */
  const latestRead = useRef(0)
  /** Bumped to open the editor's search panel. */
  const [findNonce, setFindNonce] = useState(0)
  /** Non-zero while the preview's find bar is open; bumped to refocus it. */
  const [previewFind, setPreviewFind] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  const dirty = content !== original
  /** There is text to show, which may be only the start of a very large file. */
  const readable = !!file && !file.binary
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
      const read = ++latestRead.current
      try {
        const whole = await readTextFile(absolute, tab.root)
        // Previews of images and PDFs read the file themselves.
        const f = whole.truncated && !viewOnly ? await readTextHead(absolute, tab.root) : whole
        if (read !== latestRead.current) return
        setFile(f)
        // Reload disk-backed previews only when the file changed (or on an
        // explicit refresh), so coming back to the tab keeps a PDF's page.
        const signature = f.binary || f.truncated ? String(f.size) : f.content
        if (force || seen.current !== signature) setVersion((v) => v + 1)
        seen.current = signature
        setError(null)
        // Reloading must not silently throw away work in progress.
        setBuffer((b) => followDisk(b, f.content, discardEdits))
      } catch (e) {
        if (read !== latestRead.current) return
        setError(String(e))
        setFile(null)
      } finally {
        setLoading(false)
      }
    },
    [absolute, tab.root, viewOnly],
  )

  useEffect(() => {
    if (visible) void load(false)
  }, [visible, load])

  // A tab behind another is read when it comes back, so only this one watches.
  const watching = useSettings((s) => s.settings.panel.watch)
  useFileChanges(absolute, visible && watching, () => void load(false))

  const wordWrap = useSettings((s) => s.settings.editor.wordWrap)
  const patchSettings = useSettings((s) => s.patch)

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
      await writeTextFile(absolute, content, tab.root)
      // Whatever was typed while this ran stays an edit.
      setBuffer((b) => ({ ...b, original: content }))
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
  }, [absolute, content, t, tab.root])

  const save = useCallback(async () => {
    // Not `editable` means only part of the file is here to be written back.
    if (!dirty || saving || !editable) return
    // Agents are editing these same files in the next tab along, so check what
    // is actually on disk before overwriting it.
    try {
      const onDisk = await readTextFile(absolute, tab.root)
      if (!onDisk.binary && onDisk.content !== original) {
        setConflict(onDisk.content)
        return
      }
    } catch {
      // Unreadable now: fall through and let the write report the real error.
    }
    await write()
  }, [absolute, dirty, editable, original, saving, write])

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
  /** Where ⌘F searches: the editor, the rendered Markdown, or nowhere. */
  const findTarget =
    !readable ? null : showSource ? 'source' : kind === 'markdown' && editable ? 'preview' : null
  const openFind = useCallback(() => {
    if (findTarget === 'source') setFindNonce((n) => n + 1)
    if (findTarget === 'preview') setPreviewFind((n) => n + 1)
  }, [findTarget])

  // ⌘F is a menu item, so it arrives as an event; only the focused pane takes it.
  useEffect(() => {
    if (!focused) return
    window.addEventListener('almastudio:find', openFind)
    return () => window.removeEventListener('almastudio:find', openFind)
  }, [focused, openFind])

  // The preview's find bar belongs to the preview.
  useEffect(() => {
    if (findTarget !== 'preview') setPreviewFind(0)
  }, [findTarget])

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
        {file?.truncated && showSource && !viewOnly && (
          <span className="chip chip--dirty" title={t('editor.tooLarge')}>{t('editor.partial')}</span>
        )}
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
        {showSource && readable && (
          <button
            className={`icon-btn${wordWrap ? ' icon-btn--on' : ''}`}
            onClick={() => patchSettings('editor', { wordWrap: !wordWrap })}
            aria-label={t('editor.wordWrap')} aria-pressed={wordWrap} title={t('editor.wordWrap')}
          >
            <WrapText size={13} />
          </button>
        )}
        {findTarget && (
          <button
            className="icon-btn" onClick={openFind}
            aria-label={t('find.placeholderFile')} title={t('find.placeholderFile')}
          >
            <Search size={13} />
          </button>
        )}
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
          <button className="btn btn--sm" onClick={() => void load(true)}>
            {t('editor.revert')}
          </button>
        )}
        <button
          className="icon-btn" onClick={() => void load(!dirty, true)}
          aria-label={t('panel.refresh')} title={t('panel.refresh')}
        >
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

      <div className="fileview__stage">
      {previewFind > 0 && (
        <PreviewFind
          body={bodyRef}
          focusNonce={previewFind}
          onClose={() => setPreviewFind(0)}
        />
      )}
      <div className="diff__body" ref={bodyRef}>
        {error && <div className="empty">{error}</div>}
        {showSource ? (
          <>
            {file?.binary && <div className="empty">{t('diff.binary')}</div>}
            {readable && (
              <CodeEditor
                value={content}
                path={tab.path}
                readOnly={!editable}
                reveal={tab.reveal}
                conflictLabels={editable ? {
                  current: t('conflicts.acceptCurrent'),
                  incoming: t('conflicts.acceptIncoming'),
                  both: t('conflicts.acceptBoth'),
                } : undefined}
                onChange={(text) => setBuffer((b) => applyEdit(b, text))}
                onSave={() => void save()}
                findNonce={findNonce}
                wordWrap={wordWrap}
              />
            )}
          </>
        ) : kind === 'markdown' ? (
          editable ? (
            <MarkdownPreview source={content} path={absolute} root={tab.root} />
          ) : (
            file?.truncated && <div className="empty">{t('editor.tooLarge')}</div>
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
      </div>

      {conflict !== null && (
        <ConfirmDialog
          title={t('editor.conflictTitle')}
          message={t('editor.conflictBody')}
          confirmLabel={t('editor.overwrite')}
          danger
          onCancel={() => {
            // Take what is on disk and drop our edits.
            setBuffer({ content: conflict, original: conflict })
            setConflict(null)
          }}
          onConfirm={() => void write()}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------- find in preview ---

const FIND_ALL = 'almastudio-find'
const FIND_ACTIVE = 'almastudio-find-active'

/** CSS Custom Highlights, where the webview has them (all current ones do). */
function highlights(): Map<string, unknown> | null {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  return registry && typeof (window as { Highlight?: unknown }).Highlight === 'function' ? registry : null
}

function paint(name: string, ranges: Range[]) {
  const registry = highlights()
  if (!registry) return
  if (ranges.length === 0) registry.delete(name)
  else {
    const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight
    registry.set(name, new H(...ranges))
  }
}

/** The find bar over a rendered preview, like the terminal's. */
function PreviewFind({
  body, focusNonce, onClose,
}: { body: React.RefObject<HTMLDivElement | null>; focusNonce: number; onClose: () => void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [term, setTerm] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusNonce])

  // Searched again whenever the preview re-renders, e.g. after an edit.
  useEffect(() => {
    const root = body.current
    if (!root) return
    const run = () => {
      const found = findRanges(root, term)
      setRanges(found)
      setIndex((i) => (i < found.length ? i : 0))
    }
    run()
    const observer = new MutationObserver(run)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [body, term])

  useEffect(() => {
    paint(FIND_ALL, ranges)
    const active = ranges[index]
    paint(FIND_ACTIVE, active ? [active] : [])
    active?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [ranges, index])

  // Nothing stays painted once the bar is gone.
  useEffect(() => () => {
    paint(FIND_ALL, [])
    paint(FIND_ACTIVE, [])
  }, [])

  const step = (by: number) => {
    if (ranges.length) setIndex((i) => (i + by + ranges.length) % ranges.length)
  }

  return (
    <div className="findbar">
      <input
        ref={input}
        className="findbar__input"
        value={term}
        placeholder={t('find.placeholderFile')}
        onChange={(e) => {
          setTerm(e.target.value)
          setIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="findbar__count subtle">
        {term
          ? ranges.length > 0
            ? t('find.results', { i: index + 1, n: ranges.length })
            : t('find.noResults')
          : ''}
      </span>
      <button className="icon-btn icon-btn--tiny" aria-label={t('find.previous')} onClick={() => step(-1)}>
        <ArrowUp size={13} />
      </button>
      <button className="icon-btn icon-btn--tiny" aria-label={t('find.next')} onClick={() => step(1)}>
        <ArrowDown size={13} />
      </button>
      <button className="icon-btn icon-btn--tiny" aria-label={t('find.close')} onClick={onClose}>
        <X size={13} />
      </button>
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
