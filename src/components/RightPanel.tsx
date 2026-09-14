import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Eye, EyeOff, FileDiff, FilePlus2,
  FolderPlus, GitBranch, GitCommitHorizontal, History, ListTree, Maximize2,
  Minus, Pencil, Pin, Plus, RefreshCw, Search, Trash2, Undo2, X,
} from 'lucide-react'

import {
  createDir, createFile, findFiles, findGitRepos, gitBranches, gitCheckout,
  gitCommit, gitDiscard, gitLog, gitStage, gitStatus, gitUnstage, listDir,
  onFsChange, renamePath, trashPath, watchStart, watchStop, type RepoEntry,
} from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover, PromptDialog } from './ui'
import { DirIcon, FileIcon } from './FileIcon'
import { SearchView } from './SearchView'
import type {
  BranchInfo, ChangedFile, CommitInfo, DirEntryInfo, PanelView, RepoStatus,
} from '../lib/types'

interface Props {
  projectId: string
  /** Folder the panel is actually inspecting right now. */
  root: string
  /** The project's main folder. */
  projectRoot: string
  /** The active tab's folder, when it has one. */
  tabRoot: string | null
  view: PanelView
  onViewChange: (v: PanelView) => void
  onClose: () => void
  /** Folder the panel is locked to, or null when it follows the active tab. */
  pinnedRoot: string | null
  onScopeChange: (scope: 'project' | 'tab') => void
  /** Locks the panel to an arbitrary folder — a repository found beneath it. */
  onPickRoot: (path: string) => void
}

export function RightPanel({
  projectId, root, projectRoot, tabRoot, view, onViewChange, onClose, pinnedRoot,
  onScopeChange, onPickRoot,
}: Props) {
  const t = useT()
  const settings = useSettings((s) => s.settings)
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(async () => {
    if (!root) return
    setRefreshing(true)
    try {
      setStatus(await gitStatus(root))
    } catch {
      setStatus(null)
    } finally {
      setRefreshing(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh, tick])

  // One watcher per inspected folder, driving every view in the panel.
  useEffect(() => {
    if (!root || !settings.panel.watch) return
    const id = `panel-${projectId}`
    let unlisten: (() => void) | undefined
    let timer: number | undefined
    void (async () => {
      unlisten = await onFsChange(id, () => {
        // The backend already debounces; this second stage keeps a long
        // rebuild from re-querying git on every burst.
        window.clearTimeout(timer)
        timer = window.setTimeout(() => setTick((n) => n + 1), 250)
      })
      await watchStart(id, root).catch(() => {})
    })()
    return () => {
      window.clearTimeout(timer)
      unlisten?.()
      void watchStop(id).catch(() => {})
    }
  }, [projectId, root, settings.panel.watch])

  return (
    <aside className="panel">
      <div className="panel__tabs">
        <PanelTab active={view === 'changes'} onClick={() => onViewChange('changes')}
          icon={<FileDiff size={13} />} label={t('panel.changes')}
          badge={status?.files.length || undefined} />
        <PanelTab active={view === 'files'} onClick={() => onViewChange('files')}
          icon={<ListTree size={13} />} label={t('panel.files')} />
        <PanelTab active={view === 'git'} onClick={() => onViewChange('git')}
          icon={<GitBranch size={13} />} label={t('panel.git')} />
        <PanelTab active={view === 'search'} onClick={() => onViewChange('search')}
          icon={<Search size={13} />} label={t('panel.search')} />
        <span className="spacer" />
        <button
          className="icon-btn" onClick={() => setTick((n) => n + 1)}
          aria-label={t('panel.refresh')} title={t('panel.refresh')}
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
        </button>
        <button
          className="icon-btn" onClick={onClose}
          aria-label={t('panel.close')} title={t('panel.close')}
        >
          <X size={14} />
        </button>
      </div>

      <ScopeChooser
        root={root}
        projectRoot={projectRoot}
        tabRoot={tabRoot}
        pinnedRoot={pinnedRoot}
        onChoose={onScopeChange}
      />

      <div className="panel__body">
        {view === 'changes' && (
          <ChangesView
            projectId={projectId} status={status} revision={tick}
            onChanged={() => setTick((n) => n + 1)} onPickRepo={onPickRoot}
          />
        )}
        {view === 'files' && (
          <FilesView
            projectId={projectId} root={root} revision={tick}
            onChanged={() => setTick((n) => n + 1)}
          />
        )}
        {view === 'git' && (
          <GitView
            projectId={projectId} root={root} status={status} revision={tick}
            onChanged={() => setTick((n) => n + 1)} onPickRepo={onPickRoot}
          />
        )}
        {view === 'search' && <SearchView projectId={projectId} root={root} revision={tick} />}
      </div>
    </aside>
  )
}

/**
 * Shown instead of a bare "not a git repository": a folder full of projects is
 * a reasonable thing to point AlmaStudio at, and the repositories underneath
 * it are what the user actually meant.
 *
 * They are listed as an accordion rather than as a menu that swaps the panel
 * over to one of them. Drilling in was a one-way door — nothing on screen said
 * how to get back out — and with several repositories the useful view is all
 * of them at once, not one at a time.
 */
function RepoAccordion({
  projectId, root, render, onFocus,
}: {
  /** Whose pinned repositories are listed first. */
  projectId: string
  root: string
  /** Body for one repository, rendered only while its section is open. */
  render: (repo: RepoEntry) => React.ReactNode
  onFocus: (path: string) => void
}) {
  const t = useT()
  const [repos, setRepos] = useState<RepoEntry[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const autoExpanded = useRef('')
  const pinned = useWorkspace((s) => s.projects.find((p) => p.id === projectId)?.pinnedRepos)
  const togglePinnedRepo = useWorkspace((s) => s.togglePinnedRepo)

  useEffect(() => {
    let cancelled = false
    setRepos(null)
    void findGitRepos(root, 3)
      .then((r) => !cancelled && setRepos(r))
      .catch(() => !cancelled && setRepos([]))
    return () => {
      cancelled = true
    }
  }, [root])

  // Open the repositories that have something to show, once per folder — the
  // ones with changes are why the panel is being looked at.
  useEffect(() => {
    if (!repos || autoExpanded.current === root) return
    autoExpanded.current = root
    const dirty = repos.filter((r) => r.dirty > 0).map((r) => r.path)
    setOpen(new Set(dirty.length ? dirty.slice(0, 4) : repos.slice(0, 1).map((r) => r.path)))
  }, [repos, root])

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  // Pinned repositories first; each part keeps the order they were found in.
  const ordered = useMemo(() => {
    const list = repos ?? []
    if (!pinned?.length) return list
    return [
      ...list.filter((r) => pinned.includes(r.path)),
      ...list.filter((r) => !pinned.includes(r.path)),
    ]
  }, [repos, pinned])

  if (repos === null) {
    return (
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('common.loading')}</div>
      </div>
    )
  }

  if (repos.length === 0) {
    return (
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('panel.noRepo')}</div>
        <div className="subtle">{t('panel.noRepoHint', { folder: root })}</div>
      </div>
    )
  }

  return (
    <>
      <p className="discovery__hint">
        {t('panel.reposHint', { n: repos.length })}
      </p>
      {ordered.map((repo) => {
        const isOpen = open.has(repo.path)
        const isPinned = pinned?.includes(repo.path) ?? false
        return (
          <section key={repo.path} className="group repo">
            <header className="group__head">
              <button className="group__toggle" onClick={() => toggle(repo.path)}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <GitBranch size={12} />
                <span className="repo__name truncate">{repo.name}</span>
                {repo.branch && <span className="chip">{repo.branch}</span>}
                {repo.dirty > 0 && <span className="chip chip--dirty">{repo.dirty}</span>}
              </button>
              <button
                className={`icon-btn icon-btn--tiny${isPinned ? ' repo__pin--on' : ''}`}
                title={isPinned ? t('panel.unpinRepo') : t('panel.pinRepo')}
                aria-pressed={isPinned}
                onClick={() => togglePinnedRepo(projectId, repo.path)}
              >
                <Pin size={12} fill={isPinned ? 'currentColor' : 'none'} />
              </button>
              <button
                className="icon-btn icon-btn--tiny"
                title={t('panel.focusRepo')}
                onClick={() => onFocus(repo.path)}
              >
                <Maximize2 size={12} />
              </button>
            </header>
            {isOpen && <div className="repo__body">{render(repo)}</div>}
          </section>
        )
      })}
    </>
  )
}

/** Fetches one repository's status for a section that is actually open. */
function useRepoStatus(root: string, revision: number) {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void gitStatus(root)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null))
    return () => {
      cancelled = true
    }
  }, [root, revision])
  return status
}

/**
 * Which folder the panel looks at. Tabs can be opened anywhere, so this is a
 * real choice rather than a preference — and it is shown as one, with both
 * paths visible, instead of as an icon whose meaning has to be guessed.
 */
function ScopeChooser({
  root, projectRoot, tabRoot, pinnedRoot, onChoose,
}: {
  root: string
  projectRoot: string
  tabRoot: string | null
  pinnedRoot: string | null
  onChoose: (scope: 'project' | 'tab') => void
}) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const following = !pinnedRoot
  // Picking a repository found beneath the project locks the panel to a folder
  // that is neither the project nor the tab — a third state the label has to
  // account for rather than mislabelling as "Project folder".
  const custom = !!pinnedRoot && !sameFolder(pinnedRoot, projectRoot)
  const label = custom
    ? basename(pinnedRoot!) || pinnedRoot!
    : following
      ? t('panel.scopeTab')
      : t('panel.scopeProject')

  return (
    <div className="panel__scoperow">
      {/* Focusing one repository must not be a one-way door: while the panel
          is locked to a folder that is neither the project nor the tab, there
          is always a visible way back to the list it came from. */}
      {custom && (
        <button
          className="icon-btn icon-btn--tiny"
          title={t('panel.backToProject')}
          aria-label={t('panel.backToProject')}
          onClick={() => onChoose('project')}
        >
          <ArrowLeft size={13} />
        </button>
      )}
      <button
        className="panel__scope"
        title={root}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <span className="panel__scope-mode">
          {t('panel.scope')}: {label}
          <ChevronDown size={10} />
        </span>
        <span className="panel__scope-path truncate mono">
          <bdi>{root}</bdi>
        </span>
      </button>

      <Popover anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem
          icon={!following && !custom ? <Check size={13} /> : undefined}
          label={t('panel.scopeProject')}
          hint={shorten(projectRoot)}
          onClick={() => { setAnchor(null); onChoose('project') }}
        />
        <MenuItem
          icon={following ? <Check size={13} /> : undefined}
          label={t('panel.scopeTab')}
          hint={tabRoot ? shorten(tabRoot) : t('common.none')}
          onClick={() => { setAnchor(null); onChoose('tab') }}
        />
        {custom && (
          <MenuItem
            icon={<Check size={13} />}
            label={basename(pinnedRoot!) || pinnedRoot!}
            hint={shorten(pinnedRoot!)}
            onClick={() => setAnchor(null)}
          />
        )}
      </Popover>
    </div>
  )
}

const sameFolder = (a: string, b: string) =>
  a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')

/** Tail of a path, enough to tell two folders apart in a menu. */
function shorten(path: string, max = 34): string {
  const clean = path.replace(/\/+$/, '')
  return clean.length <= max ? clean : `…${clean.slice(clean.length - max + 1)}`
}

function PanelTab({
  active, onClick, icon, label, badge,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number
}) {
  return (
    <button className={`panel-tab${active ? ' panel-tab--active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge !== undefined && <span className="panel-tab__badge">{badge}</span>}
    </button>
  )
}

// --------------------------------------------------------------- changes ---

/** One repository's changes inside an accordion section. */
function RepoChanges({
  projectId, root, revision, onChanged,
}: { projectId: string; root: string; revision: number; onChanged: () => void }) {
  const t = useT()
  const status = useRepoStatus(root, revision)
  if (!status) return <div className="repo__loading subtle">{t('common.loading')}</div>
  if (status.files.length === 0) {
    return <div className="repo__loading subtle">{t('panel.noChangesHint')}</div>
  }
  return <ChangesView projectId={projectId} status={status} onChanged={onChanged} />
}

function ChangesView({
  projectId, status, onChanged, onPickRepo, revision,
}: {
  projectId: string
  status: RepoStatus | null
  onChanged: () => void
  /** Absent inside an accordion section, which is already scoped to a repo. */
  onPickRepo?: (path: string) => void
  revision?: number
}) {
  const t = useT()
  const openDiffTab = useWorkspace((s) => s.openDiffTab)
  const [confirm, setConfirm] = useState<ChangedFile | null>(null)

  const groups = useMemo(() => {
    const files = status?.files ?? []
    return {
      staged: files.filter((f) => f.staged),
      changes: files.filter((f) => f.unstaged && !f.untracked),
      untracked: files.filter((f) => f.untracked),
    }
  }, [status])

  if (!status) return <div className="empty">{t('common.loading')}</div>
  if (!status.isRepo) {
    return (
      <RepoAccordion
        projectId={projectId}
        root={status.root}
        onFocus={onPickRepo ?? (() => {})}
        render={(repo) => (
          <RepoChanges
            projectId={projectId} root={repo.path}
            revision={revision ?? 0} onChanged={onChanged}
          />
        )}
      />
    )
  }
  if (status.files.length === 0) {
    return (
      <div className="empty">
        <div>{t('panel.noChanges')}</div>
        <div className="subtle">{t('panel.noChangesHint')}</div>
      </div>
    )
  }

  const open = (f: ChangedFile, staged: boolean) =>
    openDiffTab({
      projectId,
      root: status.root,
      path: f.path,
      side: staged ? 'index' : 'worktree',
    })

  const act = async (fn: Promise<unknown>) => {
    try {
      await fn
    } finally {
      onChanged()
    }
  }

  return (
    <>
      <FileGroup
        title={t('panel.staged')} files={groups.staged}
        action={{
          icon: <Minus size={12} />, label: t('panel.unstageAll'),
          run: () => void act(gitUnstage(status.root, groups.staged.map((f) => f.path))),
        }}
        onOpen={(f) => open(f, true)}
        rowAction={{
          icon: <Minus size={12} />, label: t('panel.unstage'),
          run: (f) => void act(gitUnstage(status.root, [f.path])),
        }}
      />
      <FileGroup
        title={t('panel.unstaged')} files={groups.changes}
        action={{
          icon: <Plus size={12} />, label: t('panel.stageAll'),
          run: () => void act(gitStage(status.root, groups.changes.map((f) => f.path))),
        }}
        onOpen={(f) => open(f, false)}
        rowAction={{
          icon: <Plus size={12} />, label: t('panel.stage'),
          run: (f) => void act(gitStage(status.root, [f.path])),
        }}
        onDiscard={setConfirm}
      />
      <FileGroup
        title={t('panel.untracked')} files={groups.untracked}
        action={{
          icon: <Plus size={12} />, label: t('panel.stageAll'),
          run: () => void act(gitStage(status.root, groups.untracked.map((f) => f.path))),
        }}
        onOpen={(f) => open(f, false)}
        rowAction={{
          icon: <Plus size={12} />, label: t('panel.stage'),
          run: (f) => void act(gitStage(status.root, [f.path])),
        }}
        onDiscard={setConfirm}
      />

      {confirm && (
        <ConfirmDialog
          title={t('panel.discard')}
          message={t('panel.discardConfirm', { path: confirm.path })}
          confirmLabel={t('panel.discard')}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void act(gitDiscard(status.root, [confirm.path]))
            setConfirm(null)
          }}
        />
      )}
    </>
  )
}

function FileGroup({
  title, files, action, onOpen, rowAction, onDiscard,
}: {
  title: string
  files: ChangedFile[]
  action: { icon: React.ReactNode; label: string; run: () => void }
  onOpen: (f: ChangedFile) => void
  rowAction: { icon: React.ReactNode; label: string; run: (f: ChangedFile) => void }
  onDiscard?: (f: ChangedFile) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  if (files.length === 0) return null
  return (
    <section className="group">
      <header className="group__head">
        <button className="group__toggle" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{title}</span>
          <span className="group__count">{files.length}</span>
        </button>
        <button className="icon-btn icon-btn--tiny" title={action.label} onClick={action.run}>
          {action.icon}
        </button>
      </header>
      {open && (
        <ul className="filelist">
          {files.map((f) => (
            <li key={`${title}-${f.path}`} className="filerow" onClick={() => onOpen(f)}>
              <span className={`filerow__code filerow__code--${codeClass(f)}`}>
                {f.code.trim() || '?'}
              </span>
              <FileIcon name={basename(f.path)} size={12} />
              <span className="filerow__name truncate">{basename(f.path)}</span>
              <span className="filerow__dir truncate subtle">{dirname(f.path)}</span>
              <span className="filerow__actions">
                {onDiscard && (
                  <button
                    className="icon-btn icon-btn--tiny"
                    title={t('panel.discard')}
                    onClick={(e) => { e.stopPropagation(); onDiscard(f) }}
                  >
                    <Undo2 size={12} />
                  </button>
                )}
                <button
                  className="icon-btn icon-btn--tiny"
                  title={rowAction.label}
                  onClick={(e) => { e.stopPropagation(); rowAction.run(f) }}
                >
                  {rowAction.icon}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const basename = (p: string) => p.split('/').pop() ?? p
const dirname = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const codeClass = (f: ChangedFile) =>
  f.conflicted ? 'conflict' : f.untracked ? 'new' : f.deleted ? 'del' : 'mod'

// ----------------------------------------------------------------- files ---

interface FsTarget {
  path: string
  name: string
  isDir: boolean
}

type FsDialog =
  | { kind: 'new-file' | 'new-folder'; dir: string }
  | { kind: 'rename'; target: FsTarget }
  | { kind: 'delete'; target: FsTarget }

function FilesView({
  projectId, root, revision, onChanged,
}: { projectId: string; root: string; revision: number; onChanged: () => void }) {
  const t = useT()
  const settings = useSettings((s) => s.settings)
  const patch = useSettings((s) => s.patch)
  const openFileTab = useWorkspace((s) => s.openFileTab)
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<DirEntryInfo[] | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; target: FsTarget } | null>(null)
  const [dialog, setDialog] = useState<FsDialog | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A non-empty filter switches the tree out for a flat ranked search.
  useEffect(() => {
    const q = filter.trim()
    if (!q) {
      setResults(null)
      return
    }
    const id = window.setTimeout(() => {
      void findFiles(root, q, 300).then(setResults).catch(() => setResults([]))
    }, 160)
    return () => window.clearTimeout(id)
  }, [filter, root])

  const run = useCallback(
    async (op: Promise<unknown>) => {
      try {
        await op
        setError(null)
      } catch (e) {
        setError(t('fs.failed', { error: String(e) }))
      } finally {
        // The watcher usually catches this, but acting immediately keeps the
        // tree honest when watching is switched off.
        onChanged()
      }
    },
    [onChanged, t],
  )

  const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

  return (
    <div className="files">
      <div className="files__bar">
        <input
          className="input input--sm"
          placeholder={t('panel.filterFiles')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="icon-btn" title={t('fs.newFile')}
          onClick={() => setDialog({ kind: 'new-file', dir: root })}
        >
          <FilePlus2 size={13} />
        </button>
        <button
          className="icon-btn" title={t('fs.newFolder')}
          onClick={() => setDialog({ kind: 'new-folder', dir: root })}
        >
          <FolderPlus size={13} />
        </button>
        <button
          className="icon-btn" aria-pressed={settings.panel.showHidden}
          title={t('panel.showHidden')}
          onClick={() => patch('panel', { showHidden: !settings.panel.showHidden })}
        >
          {settings.panel.showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>

      {error && <div className="files__error">{error}</div>}

      <div className="files__tree">
        {results ? (
          results.length === 0 ? (
            <div className="empty">{t('panel.emptyFolder')}</div>
          ) : (
            <ul className="filelist">
              {results.map((e) => (
                <li
                  key={e.path} className="filerow"
                  onClick={() => openFileTab({ projectId, root, path: e.rel })}
                  onContextMenu={(ev) => {
                    ev.preventDefault()
                    setMenu({
                      anchor: ev.currentTarget as HTMLElement,
                      target: { path: e.path, name: e.name, isDir: false },
                    })
                  }}
                >
                  <FileIcon name={e.name} size={12} />
                  <span className="filerow__name truncate">{e.name}</span>
                  <span className="filerow__dir truncate subtle">{dirname(e.rel)}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <TreeNode
            projectId={projectId} root={root} dir={root} depth={0}
            revision={revision} defaultOpen
            onContext={(target, anchor) => setMenu({ anchor, target })}
          />
        )}
      </div>

      <Popover anchor={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)}>
        {menu?.target.isDir && (
          <>
            <MenuItem
              icon={<FilePlus2 size={13} />} label={t('fs.newFile')}
              onClick={() => {
                const dir = menu.target.path
                setMenu(null)
                setDialog({ kind: 'new-file', dir })
              }}
            />
            <MenuItem
              icon={<FolderPlus size={13} />} label={t('fs.newFolder')}
              onClick={() => {
                const dir = menu.target.path
                setMenu(null)
                setDialog({ kind: 'new-folder', dir })
              }}
            />
            <MenuSeparator />
          </>
        )}
        <MenuItem
          icon={<Pencil size={13} />} label={t('fs.rename')}
          onClick={() => {
            const target = menu!.target
            setMenu(null)
            setDialog({ kind: 'rename', target })
          }}
        />
        <MenuItem
          label={t('fs.reveal')}
          onClick={() => {
            const path = menu!.target.path
            setMenu(null)
            void revealItemInDir(path).catch(() => {})
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 size={13} />} label={t('fs.delete')} danger
          onClick={() => {
            const target = menu!.target
            setMenu(null)
            setDialog({ kind: 'delete', target })
          }}
        />
      </Popover>

      {dialog?.kind === 'new-file' && (
        <PromptDialog
          title={t('fs.newFileIn', { folder: basename(dialog.dir) || dialog.dir })}
          label={t('fs.name')} confirmLabel={t('fs.create')}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void run(createFile(join(dialog.dir, name)))
          }}
        />
      )}
      {dialog?.kind === 'new-folder' && (
        <PromptDialog
          title={t('fs.newFolderIn', { folder: basename(dialog.dir) || dialog.dir })}
          label={t('fs.name')} confirmLabel={t('fs.create')}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void run(createDir(join(dialog.dir, name)))
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptDialog
          title={t('fs.renameTitle')} label={t('fs.name')}
          initial={dialog.target.name} confirmLabel={t('common.save')} selectBase
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            const parent = dialog.target.path.slice(
              0,
              Math.max(0, dialog.target.path.lastIndexOf('/')),
            )
            setDialog(null)
            void run(renamePath(dialog.target.path, join(parent, name)))
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('fs.delete')}
          message={t('fs.deleteConfirm', { name: dialog.target.name })}
          confirmLabel={t('fs.delete')} danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const path = dialog.target.path
            setDialog(null)
            void run(trashPath(path))
          }}
        />
      )}
    </div>
  )
}

function TreeNode({
  projectId, root, dir, depth, name, defaultOpen, revision, onContext,
}: {
  projectId: string; root: string; dir: string; depth: number
  name?: string; defaultOpen?: boolean; revision: number
  onContext: (target: FsTarget, anchor: HTMLElement) => void
}) {
  const settings = useSettings((s) => s.settings)
  const openFileTab = useWorkspace((s) => s.openFileTab)
  const [open, setOpen] = useState(!!defaultOpen)
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null)
  const loadedFor = useRef('')

  useEffect(() => {
    if (!open) return
    // `revision` is part of the key so a create/rename/delete anywhere
    // invalidates every expanded directory rather than leaving stale rows.
    const key = `${dir}|${settings.panel.showHidden}|${settings.panel.respectGitignore}|${revision}`
    if (loadedFor.current === key) return
    loadedFor.current = key
    void listDir(root, dir, settings.panel.showHidden, settings.panel.respectGitignore)
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [open, dir, root, revision, settings.panel.showHidden, settings.panel.respectGitignore])

  const childDepth = name === undefined ? depth : depth + 1

  return (
    <>
      {name !== undefined && (
        <button
          className="treerow" style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={(ev) => {
            ev.preventDefault()
            onContext({ path: dir, name, isDir: true }, ev.currentTarget)
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <DirIcon open={open} size={12} />
          <span className="truncate">{name}</span>
        </button>
      )}
      {open &&
        entries?.map((e) =>
          e.isDir ? (
            <TreeNode
              key={e.path} projectId={projectId} root={root} dir={e.path}
              depth={childDepth} name={e.name} revision={revision} onContext={onContext}
            />
          ) : (
            <button
              key={e.path} className="treerow"
              style={{ paddingLeft: 6 + childDepth * 12 + 14 }}
              onClick={() => openFileTab({ projectId, root, path: e.rel })}
              onContextMenu={(ev) => {
                ev.preventDefault()
                onContext({ path: e.path, name: e.name, isDir: false }, ev.currentTarget)
              }}
            >
              <FileIcon name={e.name} size={12} />
              <span className="truncate">{e.name}</span>
            </button>
          ),
        )}
    </>
  )
}

// ------------------------------------------------------------------- git ---

/** One repository's git panel inside an accordion section. */
function RepoGit({
  projectId, root, revision, onChanged,
}: { projectId: string; root: string; revision: number; onChanged: () => void }) {
  const t = useT()
  const status = useRepoStatus(root, revision)
  if (!status) return <div className="repo__loading subtle">{t('common.loading')}</div>
  return <GitView projectId={projectId} root={root} status={status} onChanged={onChanged} />
}

function GitView({
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
  const [message, setMessage] = useState('')
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!status?.isRepo) return
    void gitLog(root, 40).then(setCommits).catch(() => setCommits([]))
    void gitBranches(root).then(setBranches).catch(() => setBranches([]))
  }, [root, status])

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

  const stagedCount = status.files.filter((f) => f.staged).length

  const commit = async (all: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await gitCommit(root, message, all)
      setMessage('')
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="git">
      <div className="git__branch">
        <GitBranch size={13} />
        <span className="truncate">{status.branch ?? 'HEAD'}</span>
        {status.ahead > 0 && <span className="chip">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="chip">↓{status.behind}</span>}
      </div>

      <div className="git__commit">
        <textarea
          className="textarea" rows={3} value={message}
          placeholder={t('panel.commitMessage')}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="row">
          <button
            className="btn btn--primary btn--sm"
            disabled={busy || !message.trim() || stagedCount === 0}
            onClick={() => void commit(false)}
          >
            <GitCommitHorizontal size={13} /> {t('panel.commit')}
            {stagedCount > 0 ? ` (${stagedCount})` : ''}
          </button>
          <button
            className="btn btn--sm" disabled={busy || !message.trim()}
            onClick={() => void commit(true)}
          >
            {t('panel.commitAll')}
          </button>
        </div>
        {error && <div className="git__error">{error}</div>}
      </div>

      <section className="group">
        <header className="group__head">
          <span className="group__toggle"><History size={12} /> {t('panel.history')}</span>
        </header>
        <ul className="commits">
          {commits.map((c) => (
            <li key={c.id} className="commit" title={`${c.author} <${c.email}>`}>
              <span className="commit__id mono">{c.shortId}</span>
              <span className="commit__summary truncate">{c.summary}</span>
              <span className="commit__time subtle">{relativeTime(c.time)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="group">
        <header className="group__head">
          <span className="group__toggle"><GitBranch size={12} /> {t('panel.branches')}</span>
        </header>
        <ul className="filelist">
          {branches.filter((b) => !b.isRemote).map((b) => (
            <li
              key={b.name}
              className={`filerow${b.isHead ? ' filerow--current' : ''}`}
              onClick={() => {
                if (b.isHead) return
                void gitCheckout(root, b.name).then(onChanged).catch((e) => setError(String(e)))
              }}
              title={t('panel.switchBranch')}
            >
              <GitBranch size={12} className="subtle" />
              <span className="filerow__name truncate">{b.name}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'],
    [86400 * 30, 'day'], [86400 * 365, 'month'], [Infinity, 'year'],
  ]
  const divisors = [1, 60, 3600, 86400, 86400 * 30, 86400 * 365]
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', {
    numeric: 'auto',
  })
  for (let i = 0; i < units.length; i++) {
    if (diff < units[i][0]) return rtf.format(-Math.round(diff / divisors[i]), units[i][1])
  }
  return ''
}
