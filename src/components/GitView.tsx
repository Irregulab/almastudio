import { useEffect, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight,
  ChevronsDownUp, ChevronsUpDown, CloudUpload, Ellipsis, GitBranch, GitBranchPlus,
  GitCompareArrows, GitGraph, GitMerge, History, Loader2, Pencil, RefreshCcw, RefreshCw, Tag,
  Trash2, TriangleAlert, Undo2, ArrowUpDown,
} from 'lucide-react'

import {
  gitAbort, gitBranches, gitCheckout, gitContinue, gitFetch, gitGraph, gitMerge, gitPull, gitPush,
  gitPushTags, gitRebase, gitStash, gitStashApply, gitStashPop, gitStashes, gitSync, gitTags,
  gitUndoCommit,
} from '../lib/ipc'
import { relativeTime } from '../lib/time'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { CommitBox, setCommitMessage } from './CommitBox'
import { CommitGraph } from './CommitGraph'
import { RepoAccordion, useRepoStatus } from './RepoAccordion'
import { useGitActions, type GitDialog } from './gitActions'
import { MenuItem, MenuSeparator, Popover } from './ui'
import type { BranchInfo, GraphCommit, RepoStatus, StashInfo, TagInfo } from '../lib/types'

/** Commits loaded into the graph at a time. */
const GRAPH_PAGE = 200

const OPERATION_LABELS: Record<NonNullable<RepoStatus['operation']>, string> = {
  merge: 'git.opMerge',
  rebase: 'git.opRebase',
  'cherry-pick': 'git.opCherryPick',
  revert: 'git.opRevert',
  bisect: 'git.opBisect',
}

type Menu =
  | { kind: 'more'; anchor: HTMLElement }
  | { kind: 'branch'; anchor: HTMLElement; branch: BranchInfo }
  | { kind: 'stash'; anchor: HTMLElement; stash: StashInfo }

/** One repository's git panel inside an accordion section. */
function RepoGit({
  projectId, root, revision, onChanged,
}: { projectId: string; root: string; revision: number; onChanged: () => void }) {
  const t = useT()
  const status = useRepoStatus(root, revision)
  if (!status) return <div className="repo__loading subtle">{t('common.loading')}</div>
  return <GitView projectId={projectId} root={root} status={status} onChanged={onChanged} />
}

/**
 * The Git view: what VS Code's Source Control offers — fetch, pull, push and
 * sync, committing, undoing a commit, branches, stashes and tags, and a way
 * through a merge or rebase stopped on conflicts — above the commit graph.
 */
export function GitView({
  projectId, root, status, onChanged, onPickRepo, revision,
}: {
  projectId: string
  root: string
  status: RepoStatus | null
  onChanged: () => void
  onPickRepo?: (path: string) => void
  revision?: number
}) {
  const t = useT()
  const openGraphTab = useWorkspace((s) => s.openGraphTab)
  const [commits, setCommits] = useState<GraphCommit[] | null>(null)
  const [limit, setLimit] = useState(GRAPH_PAGE)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [stashes, setStashes] = useState<StashInfo[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const actions = useGitActions(status?.root ?? root, onChanged)
  /** The last "expand/collapse all"; every section follows it, see Section. */
  const [sections, setSections] = useState<{ open: boolean; nonce: number } | null>(null)
  const sectionsOpen = sections?.open ?? true

  useEffect(() => {
    if (!status?.isRepo) return
    void gitGraph(root, limit).then(setCommits).catch(() => setCommits([]))
    void gitBranches(root).then(setBranches).catch(() => setBranches([]))
    void gitStashes(root).then(setStashes).catch(() => setStashes([]))
    void gitTags(root).then(setTags).catch(() => setTags([]))
  }, [root, status, limit])

  if (!status?.isRepo) {
    return (
      <RepoAccordion
        projectId={projectId}
        root={root}
        onFocus={onPickRepo ?? (() => {})}
        render={(repo) => (
          <RepoGit
            projectId={projectId} root={repo.path} revision={revision ?? 0} onChanged={onChanged}
          />
        )}
      />
    )
  }

  const repo = status.root
  const current = status.branch ?? 'HEAD'
  const { busy, running } = actions
  const conflicts = status.files.filter((f) => f.conflicted).length
  const local = branches.filter((b) => !b.isRemote)
  const remote = branches.filter((b) => b.isRemote && !b.name.endsWith('/HEAD'))

  /** Runs an operation from a menu, closing the menu first. */
  const act = (name: string, op: () => Promise<unknown>, done?: string) => {
    setMenu(null)
    return actions.run(name, op, done)
  }
  const ask = (dialog: GitDialog) => {
    setMenu(null)
    actions.ask(dialog)
  }
  const openMenu = (next: Menu) => {
    if (!busy) setMenu(next)
  }
  const openGraph = () => {
    setMenu(null)
    openGraphTab({ projectId, root: repo })
  }

  return (
    <div className="git">
      <div className="git__branch">
        <GitBranch size={13} />
        <span className="truncate">{current}</span>
        {status.ahead > 0 && <span className="chip">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="chip">↓{status.behind}</span>}
        {actions.notice && <span className="chip chip--ok git__notice">{actions.notice}</span>}
        <div className="git__sync">
          <OpButton
            name="fetch" running={running} label={t('panel.fetch')}
            onClick={() => void act('fetch', () => gitFetch(repo), t('panel.fetchDone'))}
          >
            <RefreshCcw size={13} />
          </OpButton>
          <OpButton
            name="pull" running={running} disabled={status.detached || !status.upstream}
            label={status.behind > 0 ? `${t('panel.pull')} (↓${status.behind})` : t('panel.pull')}
            onClick={() => void act('pull', () => gitPull(repo), t('panel.pullDone'))}
          >
            <ArrowDownToLine size={13} />
          </OpButton>
          <OpButton
            name="push" running={running} disabled={status.detached}
            label={
              !status.upstream
                ? t('panel.publish')
                : status.ahead > 0 ? `${t('panel.push')} (↑${status.ahead})` : t('panel.push')
            }
            onClick={() => void act('push', () => gitPush(repo), t('panel.pushDone'))}
          >
            {status.upstream ? <ArrowUpFromLine size={13} /> : <CloudUpload size={13} />}
          </OpButton>
          <button
            className="icon-btn"
            title={sectionsOpen ? t('panel.collapseAll') : t('panel.expandAll')}
            aria-label={sectionsOpen ? t('panel.collapseAll') : t('panel.expandAll')}
            onClick={() =>
              setSections({ open: !sectionsOpen, nonce: (sections?.nonce ?? 0) + 1 })
            }
          >
            {sectionsOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
          </button>
          <button
            className="icon-btn" title={t('git.more')} aria-label={t('git.more')} disabled={busy}
            onClick={(e) => openMenu({ kind: 'more', anchor: e.currentTarget })}
          >
            <Ellipsis size={14} />
          </button>
        </div>
      </div>

      {status.operation && (
        <div className="git__operation">
          <TriangleAlert size={14} />
          <div className="git__operation-text">
            <strong>{t(OPERATION_LABELS[status.operation])}</strong>
            <span>
              {conflicts > 0 ? t('git.conflicts', { n: conflicts }) : t('git.readyToContinue')}
            </span>
          </div>
          <div className="row">
            {status.operation !== 'bisect' && (
              <button
                className="btn btn--sm btn--primary" disabled={busy || conflicts > 0}
                onClick={() => void act('continue', () => gitContinue(repo))}
              >
                {t('git.continue')}
              </button>
            )}
            <button
              className="btn btn--sm" disabled={busy}
              onClick={() => void act('abort', () => gitAbort(repo))}
            >
              {t('git.abort')}
            </button>
          </div>
        </div>
      )}

      {actions.error && <div className="git__error git__error--block">{actions.error}</div>}

      <CommitBox root={repo} status={status} onChanged={onChanged} />

      <BranchSection
        command={sections}
        branches={local}
        busy={busy}
        onCheckout={(name) => void act('checkout', () => gitCheckout(repo, name))}
        onMenu={(anchor, branch) => openMenu({ kind: 'branch', anchor, branch })}
        onNew={() => ask({ kind: 'new-branch', base: current })}
        t={t}
      />

      {remote.length > 0 && (
        <BranchSection
          command={sections}
          branches={remote}
          busy={busy}
          isRemote
          defaultOpen={false}
          onCheckout={(name) => void act('checkout', () => gitCheckout(repo, name, true))}
          onMenu={(anchor, branch) => openMenu({ kind: 'branch', anchor, branch })}
          t={t}
        />
      )}

      {stashes.length > 0 && (
        <Section
          command={sections} icon={<Archive size={12} />}
          title={t('git.stashes')} count={stashes.length}
        >
          <ul className="filelist">
            {stashes.map((s) => (
              <li
                key={s.id} className="filerow" title={`stash@{${s.index}}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu({ kind: 'stash', anchor: e.currentTarget, stash: s })
                }}
              >
                <Archive size={12} className="subtle" />
                <span className="filerow__name truncate">{s.message}</span>
                <span className="git__meta subtle">{relativeTime(s.time)}</span>
                <span className="filerow__actions">
                  <button
                    className="icon-btn icon-btn--tiny" title={t('git.more')} aria-label={t('git.more')}
                    onClick={(e) => openMenu({ kind: 'stash', anchor: e.currentTarget, stash: s })}
                  >
                    <Ellipsis size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tags.length > 0 && (
        <Section
        command={sections}
          icon={<Tag size={12} />} title={t('git.tags')} count={tags.length} defaultOpen={false}
          action={{
            icon: <Tag size={12} />, label: t('git.newTag'),
            run: () => ask({ kind: 'new-tag', base: current }),
          }}
        >
          <ul className="filelist">
            {tags.map((tag) => (
              <li key={tag.name} className="filerow" title={tag.target}>
                <Tag size={12} className="subtle" />
                <span className="filerow__name truncate">{tag.name}</span>
                <span className="git__meta subtle mono">{tag.target}</span>
                <span className="filerow__actions">
                  <button
                    className="icon-btn icon-btn--tiny" title={t('git.deleteTag')}
                    aria-label={t('git.deleteTag')} disabled={busy}
                    onClick={() => ask({ kind: 'delete-tag', name: tag.name })}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        command={sections}
        icon={<History size={12} />} title={t('panel.history')}
        action={{ icon: <GitGraph size={12} />, label: t('graph.open'), run: openGraph }}
      >
        {commits && commits.length === 0 && (
          <div className="repo__loading subtle">{t('panel.noCommits')}</div>
        )}
        {commits && commits.length > 0 && <CommitGraph commits={commits} />}
        {commits && commits.length >= limit && (
          <button className="btn btn--sm graph__more" onClick={() => setLimit((n) => n + GRAPH_PAGE)}>
            {t('panel.showMore')}
          </button>
        )}
      </Section>

      <Popover
        anchor={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)}
        align={menu?.kind === 'more' ? 'end' : 'start'}
      >
        {menu?.kind === 'more' && (
          <>
            <MenuItem
              icon={<RefreshCw size={13} />} label={t('git.sync')}
              disabled={!status.upstream || status.detached}
              onClick={() => void act('sync', () => gitSync(repo), t('git.syncDone'))}
            />
            <MenuItem
              icon={<ArrowDownToLine size={13} />} label={t('git.pullRebase')}
              disabled={!status.upstream || status.detached}
              onClick={() => void act('pull', () => gitPull(repo, true), t('panel.pullDone'))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Undo2 size={13} />} label={t('git.undoCommit')} disabled={!commits?.length}
              onClick={() =>
                void act('undo', async () => setCommitMessage(repo, await gitUndoCommit(repo)), t('git.undoDone'))
              }
            />
            <MenuItem icon={<GitGraph size={13} />} label={t('graph.open')} onClick={openGraph} />
            <MenuSeparator />
            <MenuItem
              icon={<GitBranchPlus size={13} />} label={t('git.newBranch')}
              onClick={() => ask({ kind: 'new-branch', base: current })}
            />
            <MenuItem
              icon={<Archive size={13} />} label={t('git.stash')} disabled={status.files.length === 0}
              onClick={() => void act('stash', () => gitStash(repo, false))}
            />
            <MenuItem
              icon={<Archive size={13} />} label={t('git.stashUntracked')}
              disabled={status.files.length === 0}
              onClick={() => void act('stash', () => gitStash(repo, true))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Tag size={13} />} label={t('git.newTag')} disabled={!commits?.length}
              onClick={() => ask({ kind: 'new-tag', base: current })}
            />
            <MenuItem
              icon={<CloudUpload size={13} />} label={t('git.pushTags')} disabled={tags.length === 0}
              onClick={() => void act('push-tags', () => gitPushTags(repo), t('panel.pushDone'))}
            />
          </>
        )}

        {menu?.kind === 'branch' && !menu.branch.isRemote && (
          <>
            <MenuItem
              icon={<GitBranch size={13} />} label={t('git.checkout')} disabled={menu.branch.isHead}
              onClick={() => void act('checkout', () => gitCheckout(repo, menu.branch.name))}
            />
            <MenuItem
              icon={<GitMerge size={13} />} label={t('git.merge', { current })}
              disabled={menu.branch.isHead || status.detached}
              onClick={() => void act('merge', () => gitMerge(repo, menu.branch.name))}
            />
            <MenuItem
              icon={<GitCompareArrows size={13} />} label={t('git.rebase', { current })}
              disabled={menu.branch.isHead || status.detached}
              onClick={() => void act('rebase', () => gitRebase(repo, menu.branch.name))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Pencil size={13} />} label={t('git.rename')}
              onClick={() => ask({ kind: 'rename-branch', name: menu.branch.name })}
            />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.delete')} danger disabled={menu.branch.isHead}
              onClick={() => ask({ kind: 'delete-branch', name: menu.branch.name, force: false })}
            />
          </>
        )}

        {menu?.kind === 'branch' && menu.branch.isRemote && (
          <>
            <MenuItem
              icon={<GitBranch size={13} />} label={t('git.checkout')}
              onClick={() => void act('checkout', () => gitCheckout(repo, menu.branch.name, true))}
            />
            <MenuItem
              icon={<GitMerge size={13} />} label={t('git.merge', { current })} disabled={status.detached}
              onClick={() => void act('merge', () => gitMerge(repo, menu.branch.name))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.deleteRemoteBranch')} danger
              onClick={() => ask({ kind: 'delete-remote-branch', name: menu.branch.name })}
            />
          </>
        )}

        {menu?.kind === 'stash' && (
          <>
            <MenuItem
              icon={<ArchiveRestore size={13} />} label={t('git.stashApply')}
              onClick={() => void act('stash-apply', () => gitStashApply(repo, menu.stash.index))}
            />
            <MenuItem
              icon={<ArchiveRestore size={13} />} label={t('git.stashPop')}
              onClick={() => void act('stash-pop', () => gitStashPop(repo, menu.stash.index))}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={13} />} label={t('git.stashDrop')} danger
              onClick={() => ask({ kind: 'drop-stash', stash: menu.stash })}
            />
          </>
        )}
      </Popover>

      {actions.dialogs}
    </div>
  )
}

function OpButton({
  name, running, disabled, label, onClick, children,
}: {
  name: string
  running: string | null
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className="icon-btn" title={label} aria-label={label}
      disabled={disabled || running !== null} onClick={onClick}
    >
      {running === name ? <Loader2 size={13} className="spin" /> : children}
    </button>
  )
}

function Section({
  icon, title, count, action, extraActions, defaultOpen = true, command, children,
}: {
  icon: React.ReactNode
  title: string
  count?: number
  action?: { icon: React.ReactNode; label: string; run: () => void }
  extraActions?: React.ReactNode
  defaultOpen?: boolean
  /** Expand or collapse every section; `nonce` makes a repeat count again. */
  command?: { open: boolean; nonce: number } | null
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const applied = useRef(0)

  useEffect(() => {
    if (!command || command.nonce === applied.current) return
    applied.current = command.nonce
    setOpen(command.open)
  }, [command])
  return (
    <section className="group">
      <header className="group__head">
        <button className="group__toggle" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {icon}
          <span>{title}</span>
          {count !== undefined && <span className="group__count">{count}</span>}
        </button>
        {extraActions}
        {action && (
          <button
            className="icon-btn icon-btn--tiny" title={action.label} aria-label={action.label}
            onClick={action.run}
          >
            {action.icon}
          </button>
        )}
      </header>
      {open && children}
    </section>
  )
}


// ---------------------------------------------------------------- tree ----

type BranchSort = 'name' | 'date'

interface BranchNode {
  /** Segment label, e.g. "feature" or "my-branch". */
  label: string
  /** Full branch name when this node is a leaf. */
  branch?: BranchInfo
  children: Map<string, BranchNode>
}

/** Build a prefix-tree from a flat branch list. Empty segments (from
 *  trailing or doubled slashes) are skipped to avoid orphan nodes. */
function buildTree(branches: BranchInfo[]): Map<string, BranchNode> {
  const root = new Map<string, BranchNode>()
  for (const b of branches) {
    const parts = b.name.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let map = root
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      if (!map.has(seg)) map.set(seg, { label: seg, children: new Map() })
      const node = map.get(seg)!
      if (i === parts.length - 1) node.branch = b
      map = node.children
    }
  }
  return root
}

/** Flatten a tree into a depth-first ordered list for rendering. */
interface FlatNode {
  key: string
  depth: number
  label: string
  branch?: BranchInfo
  hasChildren: boolean
}

function flattenTree(
  map: Map<string, BranchNode>,
  collapsed: Set<string>,
  prefix = '',
  depth = 0,
): FlatNode[] {
  const out: FlatNode[] = []
  for (const [, node] of map) {
    const key = prefix ? `${prefix}/${node.label}` : node.label
    const hasChildren = node.children.size > 0
    out.push({ key, depth, label: node.label, branch: node.branch, hasChildren })
    if (hasChildren && !collapsed.has(key)) {
      out.push(...flattenTree(node.children, collapsed, key, depth + 1))
    }
  }
  return out
}

/** Sorted branch list according to the chosen sort mode.
 *  Branches with no recorded commit timestamp sort after those that have one. */
function sortBranches(branches: BranchInfo[], sort: BranchSort): BranchInfo[] {
  return [...branches].sort((a, b) => {
    if (sort === 'date') {
      const ta = a.lastCommit
      const tb = b.lastCommit
      // Null timestamps go last (treated as oldest)
      if (ta === null && tb === null) return 0
      if (ta === null) return 1
      if (tb === null) return -1
      return tb - ta // most recent first
    }
    return a.name.localeCompare(b.name)
  })
}

/**
 * Full branches section with hierarchical tree view and sort options.
 */
function BranchSection({
  branches,
  command,
  busy,
  isRemote = false,
  defaultOpen = true,
  onCheckout,
  onMenu,
  onNew,
  t,
}: {
  branches: BranchInfo[]
  command?: { open: boolean; nonce: number } | null
  busy: boolean
  isRemote?: boolean
  defaultOpen?: boolean
  onCheckout: (name: string) => void
  onMenu: (anchor: HTMLElement, branch: BranchInfo) => void
  onNew?: () => void
  t: (key: string) => string
}) {
  const [sort, setSort] = useState<BranchSort>('name')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const sorted = sortBranches(branches, sort)
  const tree = buildTree(sorted)
  const flat = flattenTree(tree, collapsed)

  const toggleNode = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const cycleSort = () => setSort((s) => (s === 'name' ? 'date' : 'name'))
  // Label describes the action (what clicking will switch *to*)
  const nextSortLabel = sort === 'name' ? t('git.sortByDate') : t('git.sortByName')

  const extraActions = (
    <>
      <button
        className="icon-btn icon-btn--tiny"
        title={nextSortLabel} aria-label={nextSortLabel}
        onClick={cycleSort}
      >
        <ArrowUpDown size={12} />
      </button>
    </>
  )

  return (
    <Section
      command={command}
      icon={isRemote ? <CloudUpload size={12} /> : <GitBranch size={12} />}
      title={isRemote ? t('git.remoteBranches') : t('git.branches')}
      count={branches.length}
      defaultOpen={defaultOpen}
      action={
        onNew
          ? { icon: <GitBranchPlus size={12} />, label: t('git.newBranch'), run: onNew }
          : undefined
      }
      extraActions={extraActions}
    >
      <ul className="filelist">
        {flat.map((node) => {
          if (!node.branch && node.hasChildren) {
            // Folder node (intermediate segment)
            const isCollapsed = collapsed.has(node.key)
            return (
              <li
                key={node.key}
                className="filerow filerow--folder"
                style={{ paddingLeft: node.depth * 12 }}
                onClick={() => toggleNode(node.key)}
              >
                {isCollapsed ? <ChevronRight size={12} className="subtle" /> : <ChevronDown size={12} className="subtle" />}
                <span className="filerow__name truncate">{node.label}</span>
              </li>
            )
          }
          if (!node.branch) return null
          const b = node.branch
          return (
            <li
              key={node.key}
              className={`filerow${b.isHead ? ' filerow--current' : ''}`}
              style={{ paddingLeft: node.depth * 12 }}
              title={b.isHead ? undefined : (isRemote ? t('git.checkout') : t('panel.switchBranch'))}
              onClick={() => {
                if (!b.isHead && !busy) onCheckout(b.name)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onMenu(e.currentTarget, b)
              }}
            >
              {node.hasChildren
                ? (collapsed.has(node.key)
                  ? <ChevronRight size={12} className="subtle" onClick={(e) => { e.stopPropagation(); toggleNode(node.key) }} />
                  : <ChevronDown size={12} className="subtle" onClick={(e) => { e.stopPropagation(); toggleNode(node.key) }} />)
                : <GitBranch size={12} className="subtle" />}
              <span className="filerow__name truncate">{node.label}</span>
              <span className="filerow__actions">
                <button
                  className="icon-btn icon-btn--tiny" title={t('git.more')} aria-label={t('git.more')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onMenu(e.currentTarget, b)
                  }}
                >
                  <Ellipsis size={12} />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
