import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, Cherry, CloudUpload, Copy, GitBranch, GitBranchPlus, GitCommitHorizontal,
  GitCompareArrows, GitGraph, GitMerge, ListFilter, Loader2, Pencil, RefreshCcw, RefreshCw,
  RotateCcw, Search, Tag, Trash2, Undo2, X,
} from 'lucide-react'

import {
  gitBranches, gitCheckout, gitCherryPick, gitCommitDetails, gitCompareCommits, gitFetch,
  gitGraph, gitMerge, gitPushTag, gitRebase, gitRevert, gitStatus, onFsChange, watchStart,
  watchStop,
} from '../lib/ipc'
import { layoutGraph, matchesCommit } from '../lib/commitGraph'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { GraphLanes, LANE, MAX_LANES, UNCOMMITTED } from './CommitGraph'
import { FileIcon } from './FileIcon'
import { useGitActions, type GitDialog } from './gitActions'
import { MenuItem, MenuSeparator, Popover } from './ui'
import type {
  BranchInfo, CommitDetails, CommitFile, GraphCommit, GraphTab, RefLabel, RepoStatus,
} from '../lib/types'

/** Commits loaded at a time. */
const PAGE = 500

const RESET_LABELS = {
  soft: 'graph.resetSoft',
  mixed: 'graph.resetMixed',
  hard: 'graph.resetHard',
} as const

type Menu =
  | { kind: 'commit'; anchor: HTMLElement; commit: GraphCommit }
  | { kind: 'ref'; anchor: HTMLElement; ref: RefLabel }
  | { kind: 'filter'; anchor: HTMLElement }

const fullRef = (b: BranchInfo) => (b.isRemote ? `refs/remotes/${b.name}` : `refs/heads/${b.name}`)
const basename = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p
const dirname = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Git Graph, as the VS Code extension shows it: a repository's history across
 * its branches in a tab of its own, with a branch filter and search, details
 * and diffs for a commit or between two, and menus on commits and their
 * branch and tag labels for everything git can do with them.
 */
export function GitGraphView({ tab, visible }: { tab: GraphTab; visible: boolean }) {
  const t = useT()
  const root = tab.root
  const watch = useSettings((s) => s.settings.panel.watch)
  const setPanel = useWorkspace((s) => s.setPanel)
  const openDiffTab = useWorkspace((s) => s.openDiffTab)
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [commits, setCommits] = useState<GraphCommit[] | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  /** Narrows the branch filter's list, which a busy repository makes long. */
  const [branchQuery, setBranchQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  /** Full names of the branches shown; null shows every branch. */
  const [shown, setShown] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [matchAt, setMatchAt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [compareWith, setCompareWith] = useState<string | null>(null)
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [compared, setCompared] = useState<CommitFile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const [s, list, all] = await Promise.all([
        gitStatus(root), gitGraph(root, limit, shown ?? undefined), gitBranches(root),
      ])
      if (seq !== loadSeq.current) return
      setStatus(s)
      setCommits(list)
      setBranches(all)
      setLoadError(null)
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(String(e))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [root, limit, shown])

  const actions = useGitActions(root, () => void load())

  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  // Follow the repository while on screen, commits made in a terminal included.
  useEffect(() => {
    if (!visible || !watch) return
    const id = `graph-${tab.id}`
    let timer: number | undefined
    let unlisten: (() => void) | undefined
    let stopped = false
    void onFsChange(id, () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), 400)
    }).then((un) => (stopped ? un() : (unlisten = un)))
    void watchStart(id, root).catch(() => {})
    return () => {
      stopped = true
      window.clearTimeout(timer)
      unlisten?.()
      void watchStop(id).catch(() => {})
    }
  }, [visible, watch, tab.id, root, load])

  const dirty = status?.files.length ?? 0
  const uncommittedLabel = t('graph.uncommitted', { n: dirty })
  const rows = useMemo(() => {
    if (!commits) return []
    const head = commits.find((c) => c.refs.some((r) => r.current))
    const list: GraphCommit[] = dirty > 0 && head
      ? [{
          id: UNCOMMITTED, shortId: '', parents: [head.id], summary: uncommittedLabel,
          author: '', email: '', time: 0, refs: [],
        }, ...commits]
      : commits
    return layoutGraph(list)
  }, [commits, dirty, uncommittedLabel])
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)))

  const matches = useMemo(
    () => rows.filter((r) => r.commit.id !== UNCOMMITTED && matchesCommit(r.commit, query)).map((r) => r.commit.id),
    [rows, query],
  )
  const matchSet = useMemo(() => new Set(matches), [matches])
  const currentMatch = query ? (matches[matchAt] ?? null) : null
  useEffect(() => setMatchAt(0), [query])
  useEffect(() => {
    if (!currentMatch) return
    bodyRef.current?.querySelector(`[data-commit="${currentMatch}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [currentMatch])

  useEffect(() => {
    setDetails(null)
    if (!selected || selected === UNCOMMITTED) return
    let live = true
    void gitCommitDetails(root, selected)
      .then((d) => live && setDetails(d))
      .catch((e) => live && setLoadError(String(e)))
    return () => {
      live = false
    }
  }, [root, selected])

  // Two commits compare older → newer: the one lower down the list is the base.
  const pair = useMemo(() => {
    if (!selected || !compareWith) return null
    const at = (id: string) => rows.findIndex((r) => r.commit.id === id)
    return at(selected) > at(compareWith)
      ? { base: selected, target: compareWith }
      : { base: compareWith, target: selected }
  }, [rows, selected, compareWith])
  const pairKey = pair ? `${pair.base}..${pair.target}` : null
  useEffect(() => {
    setCompared(null)
    if (!pair) return
    let live = true
    void gitCompareCommits(root, pair.base, pair.target)
      .then((files) => live && setCompared(files))
      .catch((e) => live && setLoadError(String(e)))
    return () => {
      live = false
    }
    // Keyed on the pair's ids, not the object rebuilt with every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, pairKey])

  const currentBranch = status?.branch ?? 'HEAD'
  const { busy, running } = actions

  const act = (name: string, op: () => Promise<unknown>, done?: string) => {
    setMenu(null)
    return actions.run(name, op, done)
  }
  const ask = (dialog: GitDialog) => {
    setMenu(null)
    actions.ask(dialog)
  }
  const copy = (text: string) => {
    setMenu(null)
    void navigator.clipboard.writeText(text).then(() => actions.flash(t('graph.copied'))).catch(() => {})
  }
  const toggleBranch = (name: string) =>
    setShown((prev) => {
      const next = prev === null ? [name] : prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
      return next.length === 0 ? null : next
    })

  const onRowClick = (e: React.MouseEvent, commit: GraphCommit) => {
    if (commit.id === UNCOMMITTED) {
      setPanel(tab.projectId, { open: true, view: 'changes' })
      return
    }
    if ((e.metaKey || e.ctrlKey) && selected && selected !== commit.id) {
      setCompareWith(compareWith === commit.id ? null : commit.id)
      return
    }
    setCompareWith(null)
    setSelected(selected === commit.id ? null : commit.id)
  }
  const closeDetails = () => {
    setSelected(null)
    setCompareWith(null)
  }

  // Never the remotes' own HEAD, which is only another name for a branch
  // already in the list.
  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase()
    return branches.filter(
      (b) => !b.name.endsWith('/HEAD') && (!q || b.name.toLowerCase().includes(q)),
    )
  }, [branches, branchQuery])

  const error = actions.error ?? loadError
  const commitMenu = menu?.kind === 'commit' ? menu.commit : null
  const refMenu = menu?.kind === 'ref' ? menu.ref : null

  return (
    <div className="ggraph">
      <div className="ggraph__bar">
        <GitGraph size={14} className="subtle" />
        <span className="ggraph__repo truncate" title={root}>{basename(root)}</span>
        {status?.branch && <span className="chip">{status.branch}</span>}
        <button
          className="btn btn--sm"
          onClick={(e) => {
            setBranchQuery('')
            setMenu({ kind: 'filter', anchor: e.currentTarget })
          }}
        >
          <ListFilter size={12} />
          {shown === null ? t('graph.branchesAll') : t('graph.branchesSome', { n: shown.length })}
          <ChevronDown size={11} />
        </button>
        <label className="ggraph__search">
          <Search size={12} className="subtle" />
          <input
            value={query} placeholder={t('graph.search')} spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length > 0) {
                setMatchAt((i) => (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length)
              }
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <span className="ggraph__count subtle">
              {matches.length > 0 ? `${matchAt + 1}/${matches.length}` : t('graph.noMatches')}
            </span>
          )}
        </label>
        <span className="spacer" />
        {actions.notice && <span className="chip chip--ok">{actions.notice}</span>}
        <button
          className="icon-btn" title={t('panel.fetch')} aria-label={t('panel.fetch')} disabled={busy}
          onClick={() => void act('fetch', () => gitFetch(root), t('panel.fetchDone'))}
        >
          {running === 'fetch' ? <Loader2 size={13} className="spin" /> : <RefreshCcw size={13} />}
        </button>
        <button
          className="icon-btn" title={t('panel.refresh')} aria-label={t('panel.refresh')}
          disabled={busy || loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {error && <div className="git__error git__error--block">{error}</div>}

      <div className="ggraph__head">
        <span style={{ width: lanes * LANE, flex: '0 0 auto' }}>{t('graph.columnGraph')}</span>
        <span className="ggraph__desc">{t('graph.columnDescription')}</span>
        <span className="ggraph__date">{t('graph.columnDate')}</span>
        <span className="ggraph__author">{t('graph.columnAuthor')}</span>
        <span className="ggraph__hash">{t('graph.columnCommit')}</span>
      </div>

      <div className="ggraph__body" ref={bodyRef}>
        {commits === null && !error && <div className="empty">{t('common.loading')}</div>}
        {commits?.length === 0 && <div className="empty">{t('panel.noCommits')}</div>}
        {rows.map((row) => {
          const { commit } = row
          const uncommitted = commit.id === UNCOMMITTED
          const classes = [
            'ggraph__row',
            uncommitted && 'is-uncommitted',
            selected === commit.id && 'is-selected',
            compareWith === commit.id && 'is-compared',
            matchSet.has(commit.id) && 'is-match',
            currentMatch === commit.id && 'is-current-match',
          ].filter(Boolean).join(' ')
          return (
            <div
              key={commit.id} data-commit={commit.id} className={classes}
              onClick={(e) => onRowClick(e, commit)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (!uncommitted && !busy) setMenu({ kind: 'commit', anchor: e.currentTarget, commit })
              }}
            >
              <div className="ggraph__graph" style={{ width: lanes * LANE }}>
                <GraphLanes row={row} lanes={lanes} />
              </div>
              <div className="ggraph__desc">
                {commit.refs.map((ref) => (
                  <button
                    key={`${ref.kind}:${ref.name}`}
                    className={`graph__ref graph__ref--${ref.kind}${ref.current ? ' graph__ref--current' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (ref.kind !== 'head' && !busy) setMenu({ kind: 'ref', anchor: e.currentTarget, ref })
                    }}
                  >
                    {ref.kind === 'tag' && <Tag size={9} />}
                    {ref.name}
                  </button>
                ))}
                <span className="ggraph__subject truncate">{commit.summary}</span>
              </div>
              <span className="ggraph__date subtle">{uncommitted ? '' : formatDate(commit.time)}</span>
              <span className="ggraph__author truncate">{commit.author}</span>
              <span className="ggraph__hash mono subtle">{commit.shortId}</span>
            </div>
          )
        })}
        {commits && commits.length >= limit && (
          <button className="btn btn--sm graph__more" onClick={() => setLimit((n) => n + PAGE)}>
            {t('panel.showMore')}
          </button>
        )}
      </div>

      {pair && compared ? (
        <div className="ggraph__details">
          <div className="ggraph__details-bar">
            <GitCompareArrows size={13} />
            <span className="mono">
              {t('graph.compare', { base: pair.base.slice(0, 7), target: pair.target.slice(0, 7) })}
            </span>
            <span className="subtle">{t('graph.files', { n: compared.length })}</span>
            <span className="spacer" />
            <button className="icon-btn" aria-label={t('graph.closeDetails')} title={t('graph.closeDetails')} onClick={closeDetails}>
              <X size={14} />
            </button>
          </div>
          <FileList
            files={compared}
            onOpen={(f, preview) => openDiffTab({
              projectId: tab.projectId, root, path: f.path, side: 'head',
              base: pair.base, target: pair.target, oldPath: f.oldPath ?? undefined, preview,
            })}
          />
        </div>
      ) : details && (
        <div className="ggraph__details">
          <div className="ggraph__details-bar">
            <GitCommitHorizontal size={13} />
            <span className="mono">{details.shortId}</span>
            <span className="subtle">
              {t('graph.files', { n: details.files.length })} · {t('graph.compareHint')}
            </span>
            <span className="spacer" />
            <button className="icon-btn" aria-label={t('graph.copyHash')} title={t('graph.copyHash')} onClick={() => copy(details.id)}>
              <Copy size={13} />
            </button>
            <button className="icon-btn" aria-label={t('graph.closeDetails')} title={t('graph.closeDetails')} onClick={closeDetails}>
              <X size={14} />
            </button>
          </div>
          <div className="ggraph__details-body">
            <div className="ggraph__summary">
              <pre className="ggraph__message">{details.message}</pre>
              <dl className="ggraph__meta">
                <dt>{t('graph.author')}</dt>
                <dd>{details.author} &lt;{details.email}&gt; · {formatDate(details.authorTime)}</dd>
                {(details.committer !== details.author || details.commitTime !== details.authorTime) && (
                  <>
                    <dt>{t('graph.committer')}</dt>
                    <dd>{details.committer} &lt;{details.committerEmail}&gt; · {formatDate(details.commitTime)}</dd>
                  </>
                )}
                {details.parents.length > 0 && (
                  <>
                    <dt>{t('graph.parents')}</dt>
                    <dd>
                      {details.parents.map((p) => (
                        <button key={p} className="ggraph__link mono" onClick={() => setSelected(p)}>
                          {p.slice(0, 7)}
                        </button>
                      ))}
                    </dd>
                  </>
                )}
                <dt>{t('graph.commit')}</dt>
                <dd className="mono">{details.id}</dd>
              </dl>
            </div>
            <FileList
              files={details.files}
              onOpen={(f, preview) => openDiffTab({
                projectId: tab.projectId, root, path: f.path, side: 'head',
                target: details.id, oldPath: f.oldPath ?? undefined, preview,
              })}
            />
          </div>
        </div>
      )}

      <Popover
        anchor={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)}
      >
        {menu?.kind === 'filter' && (
          <>
            <MenuItem
              label={t('graph.showAll')} checked={shown === null}
              onClick={() => {
                setShown(null)
                setMenu(null)
              }}
            />
            <MenuSeparator />
            <label className="popover__search">
              <Search size={12} className="subtle" />
              <input
                autoFocus value={branchQuery} spellCheck={false}
                placeholder={t('graph.filterBranches')}
                onChange={(e) => setBranchQuery(e.target.value)}
              />
            </label>
            {filteredBranches.length === 0 && (
              <div className="popover__empty subtle">{t('graph.noBranches')}</div>
            )}
            {filteredBranches.map((b) => (
              <MenuItem
                key={fullRef(b)} label={b.name}
                checked={shown?.includes(fullRef(b)) ?? false}
                onClick={() => toggleBranch(fullRef(b))}
              />
            ))}
          </>
        )}

        {commitMenu && (
          <>
            <MenuItem
              icon={<GitBranchPlus size={13} />} label={t('graph.createBranch')}
              onClick={() => ask({ kind: 'new-branch', base: commitMenu.shortId, start: commitMenu.id })}
            />
            <MenuItem
              icon={<Tag size={13} />} label={t('graph.addTag')}
              onClick={() => ask({ kind: 'new-tag', base: commitMenu.shortId, target: commitMenu.id })}
            />
            <MenuSeparator />
            <MenuItem
              icon={<GitCommitHorizontal size={13} />} label={t('graph.checkout')}
              onClick={() => void act('checkout', () => gitCheckout(root, commitMenu.id))}
            />
            <MenuItem
              icon={<GitMerge size={13} />} label={t('git.merge', { current: currentBranch })}
              disabled={status?.detached}
              onClick={() => void act('merge', () => gitMerge(root, commitMenu.id))}
            />
            <MenuItem
              icon={<GitCompareArrows size={13} />} label={t('git.rebase', { current: currentBranch })}
              disabled={status?.detached}
              onClick={() => void act('rebase', () => gitRebase(root, commitMenu.id))}
            />
            <MenuItem
              icon={<Cherry size={13} />} label={t('graph.cherryPick')}
              onClick={() => void act('cherry-pick', () => gitCherryPick(root, commitMenu.id))}
            />
            <MenuItem
              icon={<Undo2 size={13} />} label={t('graph.revert')}
              onClick={() => void act('revert', () => gitRevert(root, commitMenu.id))}
            />
            <MenuSeparator />
            {(['soft', 'mixed', 'hard'] as const).map((mode) => (
              <MenuItem
                key={mode} icon={<RotateCcw size={13} />} danger={mode === 'hard'}
                label={t(RESET_LABELS[mode], { current: currentBranch })}
                onClick={() => ask({
                  kind: 'reset', id: commitMenu.id, shortId: commitMenu.shortId, mode, branch: currentBranch,
                })}
              />
            ))}
            <MenuSeparator />
            <MenuItem icon={<Copy size={13} />} label={t('graph.copyHash')} onClick={() => copy(commitMenu.id)} />
            <MenuItem icon={<Copy size={13} />} label={t('graph.copySubject')} onClick={() => copy(commitMenu.summary)} />
          </>
        )}

        {refMenu?.kind === 'branch' && (
          <>
            <MenuItem
              icon={<GitBranch size={13} />} label={t('git.checkout')} disabled={refMenu.current}
              onClick={() => void act('checkout', () => gitCheckout(root, refMenu.name))}
            />
            <MenuItem
              icon={<GitMerge size={13} />} label={t('git.merge', { current: currentBranch })}
              disabled={refMenu.current || status?.detached}
              onClick={() => void act('merge', () => gitMerge(root, refMenu.name))}
            />
            <MenuItem
              icon={<GitCompareArrows size={13} />} label={t('git.rebase', { current: currentBranch })}
              disabled={refMenu.current || status?.detached}
              onClick={() => void act('rebase', () => gitRebase(root, refMenu.name))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Pencil size={13} />} label={t('git.rename')}
              onClick={() => ask({ kind: 'rename-branch', name: refMenu.name })}
            />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.delete')} danger disabled={refMenu.current}
              onClick={() => ask({ kind: 'delete-branch', name: refMenu.name, force: false })}
            />
          </>
        )}

        {refMenu?.kind === 'remote' && (
          <>
            <MenuItem
              icon={<GitBranch size={13} />} label={t('git.checkout')}
              onClick={() => void act('checkout', () => gitCheckout(root, refMenu.name, true))}
            />
            <MenuItem
              icon={<GitMerge size={13} />} label={t('git.merge', { current: currentBranch })}
              disabled={status?.detached}
              onClick={() => void act('merge', () => gitMerge(root, refMenu.name))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.deleteRemoteBranch')} danger
              onClick={() => ask({ kind: 'delete-remote-branch', name: refMenu.name })}
            />
          </>
        )}

        {refMenu?.kind === 'tag' && (
          <>
            <MenuItem
              icon={<CloudUpload size={13} />} label={t('graph.pushTag')}
              onClick={() => void act('push-tag', () => gitPushTag(root, refMenu.name), t('panel.pushDone'))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.deleteTag')} danger
              onClick={() => ask({ kind: 'delete-tag', name: refMenu.name })}
            />
          </>
        )}
      </Popover>

      {actions.dialogs}
    </div>
  )
}

const STATUS_LETTERS: Record<string, string> = {
  added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C', typechange: 'T',
}
const STATUS_CLASSES: Record<string, string> = {
  added: 'new', copied: 'new', deleted: 'del',
}

/**
 * The files a commit, or a comparison, changed; each opens its diff, as a
 * preview on a single click and kept open on a double click, as in VS Code.
 */
export function FileList({
  files, onOpen,
}: { files: CommitFile[]; onOpen: (file: CommitFile, preview: boolean) => void }) {
  return (
    <ul className="filelist ggraph__files">
      {files.map((f) => (
        <li
          key={`${f.oldPath ?? ''}>${f.path}`} className="filerow"
          title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          onClick={() => onOpen(f, true)}
          onDoubleClick={() => onOpen(f, false)}
        >
          <span className={`filerow__code filerow__code--${STATUS_CLASSES[f.status] ?? 'mod'}`}>
            {STATUS_LETTERS[f.status] ?? '?'}
          </span>
          <FileIcon name={basename(f.path)} size={12} />
          <span className="filerow__name truncate">{basename(f.path)}</span>
          <span className="filerow__dir truncate subtle">{dirname(f.path)}</span>
          {!f.binary && (
            <span className="ggraph__stat">
              <span className="diff__stat-add">+{f.additions}</span>{' '}
              <span className="diff__stat-del">−{f.deletions}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
