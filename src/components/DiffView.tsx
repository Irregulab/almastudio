import { useCallback, useEffect, useMemo, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ExternalLink, FileText, RefreshCw } from 'lucide-react'

import { gitDiffFile } from '../lib/ipc'
import {
  highlightLines, languageOf, mergeSyntaxAndWords, type MergedRun, type SynLine,
} from '../lib/syntax'
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
  const syntax = useDiffSyntax(diff, tab.path)

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
              <UnifiedHunk key={i} hunk={hunk} syntax={syntax.get(i)} />
            ) : (
              <SplitHunk key={i} hunk={hunk} syntax={syntax.get(i)} />
            ),
          )}
        {diff?.truncated && <div className="diff__truncated">{t('diff.truncated')}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------ --

/** Highlighted lines for one hunk, indexed by that hunk's line positions. */
type HunkSyntax = Map<number, SynLine>

/**
 * Highlights each hunk's two sides.
 *
 * A hunk is a fragment, so a grammar can only see the few lines git gave us —
 * a hunk that begins inside a block comment may colour oddly until the next
 * hunk resets it. Highlighting the whole file instead would need the blob at
 * HEAD as well as the working copy, for a payoff that only shows up in that
 * rare case, so the fragment is what gets highlighted.
 */
function useDiffSyntax(diff: FileDiff | null, path: string): Map<number, HunkSyntax> {
  const [syntax, setSyntax] = useState<Map<number, HunkSyntax>>(new Map())

  useEffect(() => {
    setSyntax(new Map())
    const language = languageOf(path)
    if (!diff || !language || diff.binary) return

    let cancelled = false
    void (async () => {
      const result = new Map<number, HunkSyntax>()
      for (let h = 0; h < diff.hunks.length; h++) {
        const lines = diff.hunks[h].lines
        const perHunk: HunkSyntax = new Map()

        // Each side is reconstructed in file order so the grammar sees
        // something that reads as contiguous source.
        for (const side of ['-', '+'] as const) {
          const indices = lines
            .map((l, i) => (l.origin === ' ' || l.origin === side ? i : -1))
            .filter((i) => i >= 0)
          if (indices.length === 0) continue

          const text = indices.map((i) => lines[i].content).join('\n')
          const highlighted = await highlightLines(text, language)
          if (cancelled) return
          if (!highlighted || highlighted.length !== indices.length) continue

          indices.forEach((lineIndex, k) => {
            // Context lines appear on both sides; either result will do.
            if (!perHunk.has(lineIndex)) perHunk.set(lineIndex, highlighted[k])
          })
        }
        if (perHunk.size) result.set(h, perHunk)
      }
      if (!cancelled) setSyntax(result)
    })()

    return () => {
      cancelled = true
    }
  }, [diff, path])

  return syntax
}

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

function Line({
  segments, content, syntax,
}: { segments?: Segment[]; content: string; syntax?: SynLine }) {
  // Four cases: plain text, syntax only, word marks only, or both overlaid.
  if (!segments && !syntax) return <>{content || ' '}</>

  if (!segments && syntax) {
    return (
      <>
        {syntax.map((tk, i) => (
          <span key={i} className={tk.cls || undefined}>{tk.text}</span>
        ))}
      </>
    )
  }

  if (!syntax) {
    return (
      <>
        {segments!.map((s, i) =>
          s.changed ? (
            <mark key={i} className="diff__word">{s.text}</mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </>
    )
  }

  const runs: MergedRun[] = mergeSyntaxAndWords(syntax, segments!)
  return (
    <>
      {runs.map((r, i) =>
        r.changed ? (
          <mark key={i} className={`diff__word ${r.cls}`.trim()}>{r.text}</mark>
        ) : (
          <span key={i} className={r.cls || undefined}>{r.text}</span>
        ),
      )}
    </>
  )
}

function UnifiedHunk({ hunk, syntax }: { hunk: DiffHunk; syntax?: HunkSyntax }) {
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
                <Line
                  segments={segs.get(i)}
                  syntax={syntax?.get(i)}
                  content={line.content}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SplitHunk({ hunk, syntax }: { hunk: DiffHunk; syntax?: HunkSyntax }) {
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
                  <Line
                    segments={segs.get(row.leftIndex!)}
                    syntax={syntax?.get(row.leftIndex!)}
                    content={row.left.content}
                  />
                )}
              </td>
              <td className="dl__num">{row.right?.newLineno ?? ''}</td>
              <td className={`dl__text mono ${row.right ? `dl--${originClass(row.right.origin)}` : 'dl--empty'}`}>
                {row.right && (
                  <Line
                    segments={segs.get(row.rightIndex!)}
                    syntax={syntax?.get(row.rightIndex!)}
                    content={row.right.content}
                  />
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
