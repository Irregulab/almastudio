import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { Code2, ExternalLink, Eye, RefreshCw, Save } from 'lucide-react'

import { readTextFile, writeTextFile } from '../lib/ipc'
import { isMarkdown, languageOf } from '../lib/syntax'
import { useUi } from '../store/ui'
import { useT } from '../i18n'
import { CodeEditor } from './CodeEditor'
import { FileIcon } from './FileIcon'
import { ConfirmDialog, Segmented } from './ui'
import type { FileContent, FileTab } from '../lib/types'

type Mode = 'preview' | 'source'

export function FileView({ tab, visible }: { tab: FileTab; visible: boolean }) {
  const t = useT()
  const setTabDirty = useUi((s) => s.setTabDirty)
  const [file, setFile] = useState<FileContent | null>(null)
  const [content, setContent] = useState('')
  /** What is on disk as far as we know; the basis for both dirty and conflict. */
  const [original, setOriginal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const markdown = isMarkdown(tab.path)
  const [mode, setMode] = useState<Mode>(markdown ? 'preview' : 'source')

  const dirty = content !== original
  const editable = !!file && !file.binary && !file.truncated

  const absolute =
    tab.path.startsWith('/') || /^[A-Za-z]:/.test(tab.path)
      ? tab.path
      : `${tab.root.replace(/\/+$/, '')}/${tab.path}`

  const load = useCallback(
    async (discardEdits = false) => {
      setLoading(true)
      try {
        const f = await readTextFile(absolute)
        setFile(f)
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

  // Clear the marker when the tab goes away, so it cannot outlive the editor.
  useEffect(() => () => setTabDirty(tab.id, false), [setTabDirty, tab.id])

  const write = useCallback(async () => {
    setSaving(true)
    try {
      await writeTextFile(absolute, content)
      setOriginal(content)
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

  const language = languageOf(tab.path)
  const showSource = !markdown || mode === 'source'

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
        <span className="spacer" />
        {markdown && (
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
        <button className="icon-btn" onClick={() => void load(!dirty)} aria-label={t('panel.refresh')}>
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
        {file?.binary && <div className="empty">{t('diff.binary')}</div>}
        {file?.truncated && <div className="empty">{t('diff.truncated')}</div>}
        {editable &&
          (showSource ? (
            <CodeEditor
              value={content}
              path={tab.path}
              onChange={setContent}
              onSave={() => void save()}
            />
          ) : (
            <MarkdownPreview source={content} />
          ))}
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

function MarkdownPreview({ source }: { source: string }) {
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
      .then((r) => !cancelled && setHtml(r.html))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [source])

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
