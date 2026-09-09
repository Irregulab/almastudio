import { useCallback, useEffect, useMemo, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ExternalLink, FileText, RefreshCw } from 'lucide-react'

import { gitDiffFile } from '../lib/ipc'
import { pairChangedLines, wordDiff, type Segment } from '../lib/wordDiff'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { Segmented } from './ui'
import type { DiffHunk, DiffSide, DiffTab, FileDiff } from '../lib/types'

export function DiffView({ tab, visible }: { tab: DiffTab; visible: boolean }) {
  const t = useT()
  const settings = useSettings((s) => s.settings)
  const openFileTab = useWorkspace((s) => s.openFileTab)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [side, setSide] = useState<DiffSide>(tab.side)
  const [layout, setLayout] = useState(settings.panel.diffView)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await gitDiffFile(tab.root, tab.path, side, settings.panel.contextLines)
      setDiff(d)
      setError(null)
    } catch (e) {
      setError(String(e))
      setDiff(null)
    } finally {
      setLoading(false)
    }
  }, [side, settings.panel.contextLines, tab.path, tab.root])

  // Only fetch while on screen: a diff tab in a background pane costs nothing.
  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  const absolute = `${tab.root.replace(/\/+$/, '')}/${tab.path}`

  return (
    <div className="diff">
      <div className="diff__bar">
        <span className="diff__path truncate mono" title={tab.path}>{tab.path}</span>
        {diff && !diff.binary && (
          <span className="diff__stat">
            <span className="diff__stat-add">+{diff.additions}</span>
            <span className="diff__stat-del">−{diff.deletions}</span>
          </span>
        )}
        <span className="spacer" />
        <Segmented
          value={side}
          onChange={setSide}
          options={[
            { value: 'worktree', label: t('diff.worktree') },
            { value: 'index', label: t('diff.index') },
            { value: 'head', label: t('diff.head') },
          ]}
        />
        <Segmented
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'unified', label: t('diff.unified') },
            { value: 'split', label: t('diff.split') },
          ]}
        />
        <button className="icon-btn" onClick={() => void load()} aria-label={t('panel.refresh')}>
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('diff.openAsFile')}
          onClick={() =>
            openFileTab({ projectId: tab.projectId, root: tab.root, path: tab.path })
          }
        >
          <FileText size={13} />
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
        {!error && diff?.binary && <div className="empty">{t('diff.binary')}</div>}
        {!error && diff && !diff.binary && diff.hunks.length === 0 && (
          <div className="empty">{t('diff.noChanges')}</div>
        )}
        {!error && diff && !diff.binary &&
          diff.hunks.map((hunk, i) =>
            layout === 'unified' ? (
              <UnifiedHunk key={i} hunk={hunk} />
            ) : (
              <SplitHunk key={i} hunk={hunk} />
            ),
          )}
        {diff?.truncated && <div className="diff__truncated">{t('diff.truncated')}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------ --

function useWordPairs(hunk: DiffHunk) {
  return useMemo(() => {
    const pairs = pairChangedLines(hunk.lines)
    const segs = new Map<number, Segment[]>()
    for (const [delIdx, addIdx] of pairs) {
      const { removed, added } = wordDiff(
        hunk.lines[delIdx].content,
        hunk.lines[addIdx].content,
      )
      segs.set(delIdx, removed)
      segs.set(addIdx, added)
    }
    return segs
  }, [hunk])
}

function Line({ segments, content }: { segments?: Segment[]; content: string }) {
  if (!segments) return <>{content || ' '}</>
  return (
    <>
      {segments.map((s, i) =>
        s.changed ? (
          <mark key={i} className="diff__word">{s.text}</mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  const segs = useWordPairs(hunk)
  return (
    <div className="hunk">
      <div className="hunk__header mono">{hunk.header}</div>
      <table className="hunk__table">
        <tbody>
          {hunk.lines.map((line, i) => (
            <tr key={i} className={`dl dl--${originClass(line.origin)}`}>
              <td className="dl__num">{line.oldLineno ?? ''}</td>
              <td className="dl__num">{line.newLineno ?? ''}</td>
              <td className="dl__sign">{line.origin === ' ' ? '' : line.origin}</td>
              <td className="dl__text mono">
                <Line segments={segs.get(i)} content={line.content} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SplitHunk({ hunk }: { hunk: DiffHunk }) {
  const segs = useWordPairs(hunk)
  const rows = useMemo(() => buildSplitRows(hunk), [hunk])
  return (
    <div className="hunk">
      <div className="hunk__header mono">{hunk.header}</div>
      <table className="hunk__table hunk__table--split">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="dl__num">{row.left?.oldLineno ?? ''}</td>
              <td className={`dl__text mono ${row.left ? `dl--${originClass(row.left.origin)}` : 'dl--empty'}`}>
                {row.left && (
                  <Line segments={segs.get(row.leftIndex!)} content={row.left.content} />
                )}
              </td>
              <td className="dl__num">{row.right?.newLineno ?? ''}</td>
              <td className={`dl__text mono ${row.right ? `dl--${originClass(row.right.origin)}` : 'dl--empty'}`}>
                {row.right && (
                  <Line segments={segs.get(row.rightIndex!)} content={row.right.content} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface SplitRow {
  left: DiffHunk['lines'][number] | null
  right: DiffHunk['lines'][number] | null
  leftIndex: number | null
  rightIndex: number | null
}

/** Lays deletions on the left and additions on the right, aligning matched runs. */
function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.origin === ' ') {
      rows.push({ left: line, right: line, leftIndex: i, rightIndex: i })
      i++
      continue
    }
    const dels: number[] = []
    while (i < lines.length && lines[i].origin === '-') dels.push(i++)
    const adds: number[] = []
    while (i < lines.length && lines[i].origin === '+') adds.push(i++)
    const rowCount = Math.max(dels.length, adds.length)
    for (let k = 0; k < rowCount; k++) {
      const l = dels[k]
      const r = adds[k]
      rows.push({
        left: l !== undefined ? lines[l] : null,
        right: r !== undefined ? lines[r] : null,
        leftIndex: l ?? null,
        rightIndex: r ?? null,
      })
    }
    if (rowCount === 0) i++
  }
  return rows
}

const originClass = (o: string) => (o === '+' ? 'add' : o === '-' ? 'del' : 'ctx')
