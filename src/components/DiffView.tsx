import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ExternalLink, FileText, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react'

import { GIT_CHANGED_EVENT } from '../hooks/useAutoFetch'
import { gitApplyHunk, gitDiffFile } from '../lib/ipc'
import {
  highlightLines, languageOf, mergeSyntaxAndWords, type MergedRun, type SynLine,
} from '../lib/syntax'
import { pairChangedLines, wordDiff, type Segment } from '../lib/wordDiff'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog, Segmented } from './ui'
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
  /** Lines picked in each hunk, by index, to stage, unstage or discard alone. */
  const [picked, setPicked] = useState<Record<number, number[]>>({})
  const anchor = useRef<{ hunk: number; line: number } | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const commits = tab.target
        ? { base: tab.base, target: tab.target, oldPath: tab.oldPath }
        : undefined
      const d = await gitDiffFile(tab.root, tab.path, side, settings.panel.contextLines, commits)
      if (seq !== loadSeq.current) return
      setDiff(d)
      setPicked({})
      setError(null)
    } catch (e) {
      if (seq === loadSeq.current) {
        setError(String(e))
        setDiff(null)
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [side, settings.panel.contextLines, tab.base, tab.oldPath, tab.path, tab.root, tab.target])

  // Only fetch while on screen: a diff tab in a background pane costs nothing.
  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  const absolute = `${tab.root.replace(/\/+$/, '')}/${tab.path}`

  // Hunks are staged, unstaged or discarded from the working tree and staged
  // views; a commit's change, or everything against HEAD, is only looked at.
  const partial = !tab.target && !!diff && !diff.binary && (side === 'worktree' || side === 'index')

  const pick = (hunk: number, line: number, range: boolean) => {
    const from = anchor.current
    setPicked((prev) => {
      const lines = diff?.hunks[hunk]?.lines ?? []
      const chosen = new Set(prev[hunk] ?? [])
      if (range && from && from.hunk === hunk) {
        const [a, b] = from.line < line ? [from.line, line] : [line, from.line]
        for (let i = a; i <= b; i++) if (lines[i] && lines[i].origin !== ' ') chosen.add(i)
      } else if (chosen.has(line)) {
        chosen.delete(line)
      } else {
        chosen.add(line)
      }
      return { ...prev, [hunk]: [...chosen].sort((x, y) => x - y) }
    })
    anchor.current = { hunk, line }
  }

  const apply = async (hunk: number, action: 'stage' | 'unstage' | 'discard') => {
    setApplying(true)
    setApplyError(null)
    try {
      const lines = picked[hunk]
      await gitApplyHunk(
        tab.root, tab.path, settings.panel.contextLines, hunk, action,
        lines?.length ? lines : undefined,
      )
      window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT))
      await load()
    } catch (e) {
      setApplyError(String(e))
    } finally {
      setApplying(false)
    }
  }

  const hunkActions = (hunk: number) => {
    if (!partial) return null
    const chosen = picked[hunk]?.length ?? 0
    const label = (whole: string, some: string) => (chosen > 0 ? t(some, { n: chosen }) : t(whole))
    const button = (title: string, icon: React.ReactNode, onClick: () => void) => (
      <button
        className="icon-btn icon-btn--tiny" title={title} aria-label={title}
        disabled={applying} onClick={onClick}
      >
        {icon}
      </button>
    )
    return (
      <span className="hunk__actions">
        {chosen > 0 && <span className="hunk__chosen">{t('diff.linesChosen', { n: chosen })}</span>}
        {side === 'worktree' ? (
          <>
            {button(label('diff.discardHunk', 'diff.discardLines'), <Undo2 size={12} />, () => setConfirmDiscard(hunk))}
            {button(label('diff.stageHunk', 'diff.stageLines'), <Plus size={12} />, () => void apply(hunk, 'stage'))}
          </>
        ) : (
          button(label('diff.unstageHunk', 'diff.unstageLines'), <Minus size={12} />, () => void apply(hunk, 'unstage'))
        )}
      </span>
    )
  }

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
        {tab.target ? (
          // A commit's change has no working tree or index to switch between.
          <span className="chip mono" title={tab.base ? `${tab.base} → ${tab.target}` : tab.target}>
            {tab.base ? `${tab.base.slice(0, 7)} → ` : ''}{tab.target.slice(0, 7)}
          </span>
        ) : (
          <Segmented
            value={side}
            onChange={setSide}
            options={[
              { value: 'worktree', label: t('diff.worktree') },
              { value: 'index', label: t('diff.index') },
              { value: 'head', label: t('diff.head') },
            ]}
          />
        )}
        <Segmented
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'unified', label: t('diff.unified') },
            { value: 'split', label: t('diff.split') },
          ]}
        />
        <button
          className="icon-btn" onClick={() => void load()}
          aria-label={t('panel.refresh')} title={t('panel.refresh')}
        >
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
        {applyError && <div className="git__error git__error--block">{applyError}</div>}
        {!error && diff?.binary && <div className="empty">{t('diff.binary')}</div>}
        {!error && diff && !diff.binary && diff.hunks.length === 0 && (
          <div className="empty">{t('diff.noChanges')}</div>
        )}
        {!error && diff && !diff.binary &&
          diff.hunks.map((hunk, i) =>
            layout === 'unified' ? (
              <UnifiedHunk
                key={i} hunk={hunk} syntax={syntax.get(i)} actions={hunkActions(i)}
                picked={partial ? (picked[i] ?? []) : undefined}
                onPick={(line, range) => pick(i, line, range)}
                pickHint={t('diff.pickLinesHint')}
              />
            ) : (
              <SplitHunk key={i} hunk={hunk} syntax={syntax.get(i)} actions={hunkActions(i)} />
            ),
          )}
        {diff?.truncated && <div className="diff__truncated">{t('diff.truncated')}</div>}
      </div>

      {confirmDiscard !== null && (
        <ConfirmDialog
          title={t('diff.discardHunk')}
          message={
            (picked[confirmDiscard]?.length ?? 0) > 0
              ? t('diff.discardLinesConfirm', { n: picked[confirmDiscard].length })
              : t('diff.discardHunkConfirm')
          }
          confirmLabel={t('panel.discard')} danger
          onCancel={() => setConfirmDiscard(null)}
          onConfirm={() => {
            const hunk = confirmDiscard
            setConfirmDiscard(null)
            void apply(hunk, 'discard')
          }}
        />
      )}
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

function UnifiedHunk({
  hunk, syntax, actions, picked, onPick, pickHint,
}: {
  hunk: DiffHunk
  syntax?: HunkSyntax
  actions?: React.ReactNode
  /** The lines picked so far; absent where lines cannot be picked. */
  picked?: number[]
  onPick?: (line: number, range: boolean) => void
  pickHint?: string
}) {
  const segs = useWordPairs(hunk)
  return (
    <div className="hunk">
      <div className="hunk__header mono">
        <span className="hunk__title truncate">{hunk.header}</span>
        {actions}
      </div>
      <table className="hunk__table">
        <tbody>
          {hunk.lines.map((line, i) => {
            // A changed line is picked by clicking its line numbers.
            const pickable = picked !== undefined && line.origin !== ' '
            const numCell = pickable
              ? {
                  className: 'dl__num dl__num--pick',
                  title: pickHint,
                  onClick: (e: React.MouseEvent) => onPick?.(i, e.shiftKey),
                }
              : { className: 'dl__num' }
            return (
              <tr
                key={i}
                className={`dl dl--${originClass(line.origin)}${picked?.includes(i) ? ' dl--picked' : ''}`}
              >
                <td {...numCell}>{line.oldLineno ?? ''}</td>
                <td {...numCell}>{line.newLineno ?? ''}</td>
                <td className="dl__sign">{line.origin === ' ' ? '' : line.origin}</td>
                <td className="dl__text mono">
                  <Line
                    segments={segs.get(i)}
                    syntax={syntax?.get(i)}
                    content={line.content}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SplitHunk({
  hunk, syntax, actions,
}: { hunk: DiffHunk; syntax?: HunkSyntax; actions?: React.ReactNode }) {
  const segs = useWordPairs(hunk)
  const rows = useMemo(() => buildSplitRows(hunk), [hunk])
  return (
    <div className="hunk">
      <div className="hunk__header mono">
        <span className="hunk__title truncate">{hunk.header}</span>
        {actions}
      </div>
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
