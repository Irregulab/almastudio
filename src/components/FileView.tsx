import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { Code2, ExternalLink, Eye, RefreshCw } from 'lucide-react'

import { readTextFile } from '../lib/ipc'
import { highlightLines, isMarkdown, languageOf, plainLines, type SynLine } from '../lib/syntax'
import { useT } from '../i18n'
import { Segmented } from './ui'
import type { FileContent, FileTab } from '../lib/types'

type Mode = 'preview' | 'source'

export function FileView({ tab, visible }: { tab: FileTab; visible: boolean }) {
  const t = useT()
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const markdown = isMarkdown(tab.path)
  const [mode, setMode] = useState<Mode>(markdown ? 'preview' : 'source')

  const absolute =
    tab.path.startsWith('/') || /^[A-Za-z]:/.test(tab.path)
      ? tab.path
      : `${tab.root.replace(/\/+$/, '')}/${tab.path}`

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setFile(await readTextFile(absolute))
      setError(null)
    } catch (e) {
      setError(String(e))
      setFile(null)
    } finally {
      setLoading(false)
    }
  }, [absolute])

  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  const language = languageOf(tab.path)
  const showSource = !markdown || mode === 'source'

  return (
    <div className="diff">
      <div className="diff__bar">
        <span className="diff__path truncate mono" title={absolute}>{tab.path}</span>
        {language && <span className="chip">{language}</span>}
        {file && <span className="chip">{formatBytes(file.size)}</span>}
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
        <button className="icon-btn" onClick={() => void load()} aria-label={t('panel.refresh')}>
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
        {file && !file.binary && !file.truncated && (
          showSource ? (
            <CodeBlock code={file.content} language={language} />
          ) : (
            <MarkdownPreview source={file.content} />
          )
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ code ---

/** Line-numbered source. Highlighting resolves asynchronously and swaps in. */
function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const plain = useMemo(() => plainLines(code), [code])
  const [lines, setLines] = useState<SynLine[]>(plain)

  useEffect(() => {
    let cancelled = false
    setLines(plain)
    void highlightLines(code, language).then((result) => {
      // Line counts must agree, or the numbers would drift from the content.
      if (!cancelled && result && result.length === plain.length) setLines(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language, plain])

  return (
    <table className="hunk__table code">
      <tbody>
        {lines.map((tokens, i) => (
          <tr key={i} className="dl dl--ctx">
            <td className="dl__num">{i + 1}</td>
            <td className="dl__text mono">
              {tokens.length === 0
                ? ' '
                : tokens.map((tk, j) =>
                    tk.cls ? (
                      <span key={j} className={tk.cls}>{tk.text}</span>
                    ) : (
                      <span key={j}>{tk.text}</span>
                    ),
                  )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
