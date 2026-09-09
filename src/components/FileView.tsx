import { useCallback, useEffect, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ExternalLink, RefreshCw } from 'lucide-react'

import { readTextFile } from '../lib/ipc'
import { useT } from '../i18n'
import type { FileContent, FileTab } from '../lib/types'

export function FileView({ tab, visible }: { tab: FileTab; visible: boolean }) {
  const t = useT()
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const absolute = tab.path.startsWith('/') || /^[A-Za-z]:/.test(tab.path)
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

  const lines = file?.content ? file.content.split('\n') : []

  return (
    <div className="diff">
      <div className="diff__bar">
        <span className="diff__path truncate mono" title={absolute}>{tab.path}</span>
        {file && <span className="chip">{formatBytes(file.size)}</span>}
        <span className="spacer" />
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
          <table className="hunk__table">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="dl dl--ctx">
                  <td className="dl__num">{i + 1}</td>
                  <td className="dl__text mono">{line || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
