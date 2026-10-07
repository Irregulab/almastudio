import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Circle, CircleCheck, MessageSquare, Pencil, RefreshCw, Send, Trash2,
} from 'lucide-react'

import { gitDiffFile, gitStatus, onFsChange, watchStart, watchStop } from '../lib/ipc'
import { uid } from '../lib/id'
import {
  COMMENT_KINDS, anchorLines, diffSignature, emptyReview, formatReview, lineAnchor,
  type CommentKind, type Review, type ReviewComment,
} from '../lib/review'
import { useReviews } from '../store/review'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { UnifiedHunk, useDiffSyntax } from './DiffView'
import { FileIcon } from './FileIcon'
import { sessionLabel } from './Pane'
import { codeClass } from './RightPanel'
import { Field, Modal, Segmented } from './ui'
import { isTerminalTab, type FileDiff, type RepoStatus, type ReviewTab } from '../lib/types'

/** A comment being written: a new one on lines picked in a hunk, or `id`'s, edited. */
interface Draft {
  id?: string
  hunk: number
  /** Where the pick started and where it reached, as indices into the hunk's lines. */
  anchor: number
  line: number
  kind: CommentKind
  body: string
}

const EMPTY = emptyReview()
const keyOf = (a: Pick<ReviewComment, 'side' | 'line'>) => `${a.side}:${a.line}`
const without = <T,>(record: Record<string, T>, keys: string[]) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)))
const basename = (p: string) => p.split('/').pop() ?? p
const dirname = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/**
 * A repository's uncommitted changes, reviewed as a pull request is: file by
 * file, with comments on lines, and the whole of it handed to a harness to
 * act on once finished.
 */
export function ReviewView({
  tab, visible, focused,
}: { tab: ReviewTab; visible: boolean; focused: boolean }) {
  const t = useT()
  const root = tab.root
  const contextLines = useSettings((s) => s.settings.panel.contextLines)
  const watch = useSettings((s) => s.settings.panel.watch)
  const review = useReviews((s) => s.reviews[root]) ?? EMPTY
  const update = useReviews((s) => s.update)
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [shown, setShown] = useState<{ path: string; diff: FileDiff } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [finishing, setFinishing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const files = useMemo(() => {
    const changed = (status?.files ?? []).map((f) => ({
      path: f.path, code: f.code.trim() || '?', cls: codeClass(f),
    }))
    // A file that is no longer changed stays listed while it has comments,
    // which would otherwise be sent without ever being seen again.
    const orphans = [...new Set(review.comments.map((c) => c.path))]
      .filter((p) => !changed.some((f) => f.path === p))
      .map((path) => ({ path, code: '·', cls: 'mod' }))
    return [...changed, ...orphans]
  }, [status, review.comments])

  const index = Math.max(0, files.findIndex((f) => f.path === selected))
  const path = files[index]?.path
  const diff = shown && shown.path === path ? shown.diff : null
  const syntax = useDiffSyntax(diff, path ?? '')
  const signature = useMemo(() => (diff ? diffSignature(diff) : null), [diff])
  const viewed = !!path && !!review.viewed[path]

  // Only while on screen, as a diff tab does.
  useEffect(() => {
    if (!visible) return
    let live = true
    void gitStatus(root)
      .then((s) => {
        if (!live) return
        setStatus(s)
        setError(null)
      })
      .catch((e) => live && setError(String(e)))
    return () => {
      live = false
    }
  }, [visible, root, tick])

  // Everything against HEAD: staged or not, it is all up for review.
  useEffect(() => {
    if (!visible || !path) return
    let live = true
    void gitDiffFile(root, path, 'head', contextLines)
      .then((d) => live && setShown({ path, diff: d }))
      .catch((e) => live && setError(String(e)))
    return () => {
      live = false
    }
  }, [visible, root, path, contextLines, tick])

  // Follow the repository while on screen: the harness edits it as it answers.
  useEffect(() => {
    if (!visible || !watch) return
    const id = `review-${tab.id}`
    let timer: number | undefined
    let unlisten: (() => void) | undefined
    let stopped = false
    void onFsChange(id, () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((n) => n + 1), 400)
    }).then((un) => (stopped ? un() : (unlisten = un)))
    void watchStart(id, root).catch(() => {})
    return () => {
      stopped = true
      window.clearTimeout(timer)
      unlisten?.()
      void watchStop(id).catch(() => {})
    }
  }, [visible, watch, tab.id, root])

  // A file that changed since it was marked as viewed needs another look.
  useEffect(() => {
    if (!path || !signature) return
    const seen = review.viewed[path]
    if (seen && seen !== signature) update(root, (r) => ({ ...r, viewed: without(r.viewed, [path]) }))
  }, [path, signature, review.viewed, root, update])

  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0)
  }, [path])

  const select = (next: string) => {
    setSelected(next)
    setDraft(null)
  }
  const go = (delta: number) => {
    const next = files[index + delta]
    if (next) select(next.path)
  }

  const toggleViewed = () => {
    if (!path || !signature) return
    update(root, (r) => ({
      ...r,
      viewed: viewed ? without(r.viewed, [path]) : { ...r.viewed, [path]: signature },
    }))
    if (viewed) return
    // Marked: on to the next file still to look at.
    const next = [...files.slice(index + 1), ...files.slice(0, index)]
      .find((f) => !review.viewed[f.path])
    if (next) select(next.path)
  }

  const jumpHunk = (delta: 1 | -1) => {
    const body = bodyRef.current
    if (!body) return
    const tops = [...body.querySelectorAll<HTMLElement>('.hunk')].map((h) => h.offsetTop)
    const top = delta > 0
      ? tops.find((y) => y > body.scrollTop + 1)
      : tops.reverse().find((y) => y < body.scrollTop - 1)
    if (top !== undefined) body.scrollTo({ top })
  }

  // Bound afresh on every render: the handler reads this render's files and
  // selection. Keys typed into a field, a terminal or a dialog are not ours.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (useUi.getState().overlays > 0) return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setFinishing(true)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'j': case 'ArrowRight': go(1); break
        case 'k': case 'ArrowLeft': go(-1); break
        case 'n': jumpHunk(1); break
        case 'p': jumpHunk(-1); break
        case 'v': toggleViewed(); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The comments each line on screen carries, and those whose lines the diff
  // no longer shows — the file was edited since, or the change undone.
  const { placed, detached } = useMemo(() => {
    const onScreen = new Set<string>()
    for (const h of diff?.hunks ?? []) for (const l of h.lines) onScreen.add(keyOf(lineAnchor(l)))
    const placed = new Map<string, ReviewComment[]>()
    const detached: ReviewComment[] = []
    for (const c of review.comments) {
      if (c.path !== path) continue
      if (onScreen.has(keyOf(c))) placed.set(keyOf(c), [...(placed.get(keyOf(c)) ?? []), c])
      else detached.push(c)
    }
    return { placed, detached }
  }, [review.comments, path, diff])

  const pick = (hunk: number, line: number, range: boolean) =>
    setDraft((d) => {
      // What was typed so far follows the pick to its new lines.
      const writing = d && !d.id ? d : null
      // ponytail: the pick is held by index, so a diff reloading mid-comment
      // can move it to other lines; snapshot the lines here if that bites.
      return {
        kind: writing?.kind ?? 'fix',
        body: writing?.body ?? '',
        hunk,
        anchor: range && writing?.hunk === hunk ? writing.anchor : line,
        line,
      }
    })

  const save = () => {
    const body = draft?.body.trim()
    if (!draft || !path || !body) return
    if (draft.id) {
      update(root, (r) => ({
        ...r,
        comments: r.comments.map((c) => (c.id === draft.id ? { ...c, body, kind: draft.kind } : c)),
      }))
    } else {
      const [from, to] = [draft.anchor, draft.line].sort((a, b) => a - b)
      const lines = diff?.hunks[draft.hunk]?.lines.slice(from, to + 1) ?? []
      if (lines.length === 0) return
      const comment: ReviewComment = {
        id: uid('comment'), path, ...anchorLines(lines), kind: draft.kind, body,
      }
      update(root, (r) => ({ ...r, comments: [...r.comments, comment] }))
    }
    setDraft(null)
  }

  const remove = (id: string) => {
    update(root, (r) => ({ ...r, comments: r.comments.filter((c) => c.id !== id) }))
    setDraft(null)
  }

  const composer = (
    <Composer
      draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)}
      onDelete={draft?.id ? () => remove(draft.id!) : undefined}
    />
  )
  const card = (c: ReviewComment) =>
    draft?.id === c.id ? (
      <div key={c.id}>{composer}</div>
    ) : (
      <CommentCard
        key={c.id} comment={c} onDelete={() => remove(c.id)}
        onEdit={() => setDraft({ id: c.id, hunk: -1, anchor: 0, line: 0, kind: c.kind, body: c.body })}
      />
    )

  const picking = draft && !draft.id ? draft : null
  const pickedIn = (hunk: number) => {
    if (picking?.hunk !== hunk) return []
    const [from, to] = [picking.anchor, picking.line].sort((a, b) => a - b)
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  const below = (hunk: number, i: number) => {
    const comments = placed.get(keyOf(lineAnchor(diff!.hunks[hunk].lines[i]))) ?? []
    const writing = picking?.hunk === hunk && Math.max(picking.anchor, picking.line) === i
    if (comments.length === 0 && !writing) return null
    return (
      <>
        {comments.map(card)}
        {writing && composer}
      </>
    )
  }

  const commentsOf = (p: string) => review.comments.filter((c) => c.path === p).length

  return (
    <div className="review">
      <div className="review__files">
        <div className="review__progress">
          {t('review.viewedCount', {
            n: files.filter((f) => review.viewed[f.path]).length, total: files.length,
          })}
        </div>
        <ul className="filelist">
          {files.map((f) => (
            <li
              key={f.path} title={f.path}
              className={`filerow${f.path === path ? ' filerow--selected' : ''}`}
              onClick={() => select(f.path)}
            >
              <span className={`filerow__code filerow__code--${f.cls}`}>{f.code}</span>
              <FileIcon name={basename(f.path)} size={12} />
              <span className="filerow__name truncate">{basename(f.path)}</span>
              <span className="filerow__dir truncate subtle">{dirname(f.path)}</span>
              {commentsOf(f.path) > 0 && (
                <span className="review__count"><MessageSquare size={11} />{commentsOf(f.path)}</span>
              )}
              {review.viewed[f.path] && <CircleCheck size={12} className="review__seen" />}
            </li>
          ))}
        </ul>
        <span className="spacer" />
        <div className="review__hint subtle">{t('review.hint')}</div>
      </div>

      <div className="diff">
        <div className="diff__bar">
          <button
            className="icon-btn" disabled={index === 0} onClick={() => go(-1)}
            aria-label={t('review.previousFile')} title={t('review.previousFile')}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="icon-btn" disabled={index >= files.length - 1} onClick={() => go(1)}
            aria-label={t('review.nextFile')} title={t('review.nextFile')}
          >
            <ChevronRight size={14} />
          </button>
          {path && <span className="subtle">{index + 1}/{files.length}</span>}
          <span className="diff__path truncate mono" title={path}>{path}</span>
          {diff && !diff.binary && (
            <span className="diff__stat">
              <span className="diff__stat-add">+{diff.additions}</span>
              <span className="diff__stat-del">−{diff.deletions}</span>
            </span>
          )}
          <span className="spacer" />
          <button
            className={`btn btn--sm${viewed ? ' review__viewed' : ''}`}
            disabled={!signature} aria-pressed={viewed} onClick={toggleViewed}
          >
            {viewed ? <CircleCheck size={13} /> : <Circle size={13} />}
            {t('review.viewed')}
          </button>
          <button
            className="icon-btn" onClick={() => setTick((n) => n + 1)}
            aria-label={t('panel.refresh')} title={t('panel.refresh')}
          >
            <RefreshCw size={13} />
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => setFinishing(true)}>
            <Send size={12} />
            {t('review.finish')}{review.comments.length > 0 ? ` (${review.comments.length})` : ''}
          </button>
        </div>

        <div className="diff__body" ref={bodyRef}>
          {error && <div className="empty">{error}</div>}
          {!error && status && files.length === 0 && <div className="empty">{t('panel.noChanges')}</div>}
          {!error && diff?.binary && <div className="empty">{t('diff.binary')}</div>}
          {!error && diff && detached.length > 0 && (
            <div className="review__detached">
              <div className="subtle">{t('review.outdated')}</div>
              {detached.map((c) => (
                <div key={c.id}>
                  <pre className="review__quote mono">{c.code}</pre>
                  {card(c)}
                </div>
              ))}
            </div>
          )}
          {!error && diff && !diff.binary && diff.hunks.length === 0 && detached.length === 0 && (
            <div className="empty">{t('diff.noChanges')}</div>
          )}
          {!error && diff && !diff.binary &&
            diff.hunks.map((hunk, h) => (
              <UnifiedHunk
                key={h} hunk={hunk} syntax={syntax.get(h)}
                picked={pickedIn(h)} pickContext pickHint={t('review.commentHint')}
                onPick={(line, range) => pick(h, line, range)}
                after={(i) => below(h, i)}
              />
            ))}
          {diff?.truncated && <div className="diff__truncated">{t('diff.truncated')}</div>}
        </div>
      </div>

      {finishing && <FinishDialog tab={tab} review={review} onClose={() => setFinishing(false)} />}
    </div>
  )
}

function CommentCard({
  comment, onEdit, onDelete,
}: { comment: ReviewComment; onEdit: () => void; onDelete: () => void }) {
  const t = useT()
  const range = comment.startLine === comment.line
    ? `${comment.line}`
    : `${comment.startLine}–${comment.line}`
  return (
    <div className={`review__comment review__comment--${comment.kind}`}>
      <div className="review__comment-head">
        <span className="chip">{t(`review.kind.${comment.kind}`)}</span>
        <span className="subtle mono">{range}</span>
        <span className="spacer" />
        <button
          className="icon-btn icon-btn--tiny" onClick={onEdit}
          aria-label={t('review.edit')} title={t('review.edit')}
        >
          <Pencil size={12} />
        </button>
        <button
          className="icon-btn icon-btn--tiny" onClick={onDelete}
          aria-label={t('common.delete')} title={t('common.delete')}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="review__comment-body">{comment.body}</div>
    </div>
  )
}

/** The comment being written. Its text lives in the draft, so it survives moving to other lines. */
function Composer({
  draft, onChange, onSave, onCancel, onDelete,
}: {
  draft: Draft | null
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const t = useT()
  if (!draft) return null
  return (
    <div className="review__composer">
      <textarea
        className="textarea" rows={3} autoFocus value={draft.body}
        placeholder={t('review.placeholder')}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSave()
          }
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="review__composer-bar">
        <Segmented
          value={draft.kind}
          onChange={(kind) => onChange({ ...draft, kind })}
          options={COMMENT_KINDS.map((k) => ({ value: k, label: t(`review.kind.${k}`) }))}
        />
        <span className="spacer" />
        {onDelete && (
          <button className="btn btn--sm btn--danger" onClick={onDelete}>{t('common.delete')}</button>
        )}
        <button className="btn btn--sm" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn btn--sm btn--primary" disabled={!draft.body.trim()} onClick={onSave}>
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}

/** The end of a review: a comment on the whole, and the harness it all goes to. */
function FinishDialog({
  tab, review, onClose,
}: { tab: ReviewTab; review: Review; onClose: () => void }) {
  const t = useT()
  const update = useReviews((s) => s.update)
  const tabs = useWorkspace((s) => s.tabs)
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab.projectId))
  const focusTab = useWorkspace((s) => s.focusTab)
  const [target, setTarget] = useState('')
  const [copied, setCopied] = useState(false)

  // The project's running agents, those working in this repository first.
  const harnesses = useMemo(() => {
    const here = (cwd: string) => Number(cwd.startsWith(tab.root) || tab.root.startsWith(cwd))
    return Object.values(tabs)
      .filter(isTerminalTab)
      .filter((x) => x.projectId === tab.projectId && x.kind !== 'shell' && x.status === 'running')
      .sort((a, b) => here(b.cwd) - here(a.cwd))
  }, [tabs, tab.projectId, tab.root])
  const chosen = harnesses.find((h) => h.id === target) ?? harnesses[0]
  const empty = review.comments.length === 0 && !review.general.trim()

  const send = () => {
    if (!chosen || empty) return
    window.dispatchEvent(new CustomEvent('almastudio:paste', {
      detail: { tabId: chosen.id, text: formatReview(review), submit: true },
    }))
    // The files commented on are about to change; the others stay viewed.
    update(tab.root, (r) => ({
      comments: [], general: '', viewed: without(r.viewed, r.comments.map((c) => c.path)),
    }))
    onClose()
    focusTab(chosen.id)
  }

  return (
    <Modal
      title={t('review.finish')}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn" disabled={empty}
            onClick={() => void navigator.clipboard.writeText(formatReview(review)).then(() => setCopied(true))}
          >
            {t(copied ? 'review.copied' : 'review.copy')}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn--primary" disabled={!chosen || empty} onClick={send}>
            {t('review.send')}
          </button>
        </>
      }
    >
      <Field
        label={t('review.general')}
        hint={t('review.summary', {
          n: review.comments.length, files: new Set(review.comments.map((c) => c.path)).size,
        })}
      >
        <textarea
          className="textarea" rows={5} autoFocus value={review.general}
          placeholder={t('review.generalPlaceholder')}
          onChange={(e) => update(tab.root, (r) => ({ ...r, general: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
      </Field>
      <Field label={t('review.sendTo')} hint={chosen ? t('review.sendHint') : t('review.noHarness')}>
        {chosen && (
          <select className="select" value={chosen.id} onChange={(e) => setTarget(e.target.value)}>
            {harnesses.map((h) => (
              <option key={h.id} value={h.id}>{sessionLabel(h, project?.root)}</option>
            ))}
          </select>
        )}
      </Field>
    </Modal>
  )
}
