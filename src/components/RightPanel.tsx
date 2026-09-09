import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  ChevronDown, ChevronRight, Eye, EyeOff, FileDiff, FilePlus2, FolderPlus,
  GitBranch, GitCommitHorizontal, History, ListTree, Minus, Pencil, Pin,
  Plus, RefreshCw, Trash2, Undo2, X,
} from 'lucide-react'

import {
  createDir, createFile, findFiles, gitBranches, gitCheckout, gitCommit,
  gitDiscard, gitLog, gitStage, gitStatus, gitUnstage, listDir, onFsChange,
  renamePath, trashPath, watchStart, watchStop,
} from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover, PromptDialog } from './ui'
import { DirIcon, FileIcon } from './FileIcon'
import type {
  BranchInfo, ChangedFile, CommitInfo, DirEntryInfo, PanelView, RepoStatus,
} from '../lib/types'

interface Props {
  projectId: string
  /** Folder the panel inspects: the pinned root, else the active tab's cwd. */
  root: string
  view: PanelView
  onViewChange: (v: PanelView) => void
  onClose: () => void
  pinned: boolean
  onTogglePin: () => void
}

export function RightPanel({
  projectId, root, view, onViewChange, onClose, pinned, onTogglePin,
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
        <span className="spacer" />
        <button
          className="icon-btn" onClick={() => setTick((n) => n + 1)}
          aria-label={t('panel.refresh')} title={t('panel.refresh')}
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
        </button>
        {/* One icon with a pressed state, rather than swapping between a pin
            and a crossed-out pin — which reads as ambiguous about whether it
            describes the current state or the action. */}
        <button
          className="icon-btn" onClick={onTogglePin} aria-pressed={pinned}
          aria-label={t('panel.pinLabel')}
          title={pinned ? t('panel.pinnedHint') : t('panel.followingHint')}
        >
          <Pin size={13} />
        </button>
        <button
          className="icon-btn" onClick={onClose}
          aria-label={t('panel.close')} title={t('panel.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="panel__scope" title={root}>
        <span className="panel__scope-mode">
          {pinned ? t('panel.pinnedShort') : t('panel.followingShort')}
        </span>
        <span className="panel__scope-path truncate mono">
          <bdi>{root}</bdi>
        </span>
      </div>

      <div className="panel__body">
        {view === 'changes' && (
          <ChangesView projectId={projectId} status={status} onChanged={() => setTick((n) => n + 1)} />
        )}
        {view === 'files' && (
          <FilesView
            projectId={projectId} root={root} revision={tick}
            onChanged={() => setTick((n) => n + 1)}
          />
        )}
        {view === 'git' && (
          <GitView root={root} status={status} onChanged={() => setTick((n) => n + 1)} />
        )}
      </div>
    </aside>
  )
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

function ChangesView({
  projectId, status, onChanged,
}: { projectId: string; status: RepoStatus | null; onChanged: () => void }) {
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
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('panel.noRepo')}</div>
        <div className="subtle">{t('panel.noRepoHint', { folder: status.root })}</div>
      </div>
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

function GitView({
  root, status, onChanged,
}: { root: string; status: RepoStatus | null; onChanged: () => void }) {
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
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('panel.noRepo')}</div>
      </div>
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
