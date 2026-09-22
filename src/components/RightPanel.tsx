import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff,
  FileDiff, FilePlus2, FolderPlus, GitBranch, ListTree, Minus, Pencil, Plus, RefreshCw, Search,
  Terminal, Trash2, Undo2, X,
} from 'lucide-react'

import {
  createDir, createFile, findFiles, gitDiscard, gitStage, gitStatus, gitUnstage, listDir,
  onFsChange, renamePath, trashPath, watchStart, watchStop,
} from '../lib/ipc'
import { GIT_CHANGED_EVENT } from '../hooks/useAutoFetch'
import { useSettings } from '../store/settings'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover, PromptDialog } from './ui'
import { CommitBox } from './CommitBox'
import { DirIcon, FileIcon } from './FileIcon'
import { GitView } from './GitView'
import { RepoAccordion, useRepoStatus } from './RepoAccordion'
import { SearchView } from './SearchView'
import type { ChangedFile, DirEntryInfo, PanelView, RepoStatus } from '../lib/types'

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
  const refreshSeq = useRef(0)

  const refresh = useCallback(async () => {
    if (!root) return
    const seq = ++refreshSeq.current
    setRefreshing(true)
    try {
      const next = await gitStatus(root)
      if (seq === refreshSeq.current) setStatus(next)
    } catch {
      if (seq === refreshSeq.current) setStatus(null)
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false)
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
    let cancelled = false
    let started = false
    let stopRequested = false
    const stop = () => { void watchStop(id).catch(() => {}) }
    void (async () => {
      unlisten = await onFsChange(id, () => {
        // The backend already debounces; this second stage keeps a long
        // rebuild from re-querying git on every burst.
        window.clearTimeout(timer)
        timer = window.setTimeout(() => setTick((n) => n + 1), 250)
      })
      if (cancelled) {
        unlisten()
        return
      }
      await watchStart(id, root).catch(() => {})
      started = true
      if (stopRequested) stop()
    })()
    return () => {
      cancelled = true
      stopRequested = true
      window.clearTimeout(timer)
      unlisten?.()
      if (started) stop()
    }
  }, [projectId, root, settings.panel.watch])

  // Git state that changed elsewhere: a background fetch, a hunk staged from a diff.
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener(GIT_CHANGED_EVENT, bump)
    return () => window.removeEventListener(GIT_CHANGED_EVENT, bump)
  }, [])

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
  const openFileTab = useWorkspace((s) => s.openFileTab)
  /** Files about to be discarded; `untracked` ones are deleted instead. */
  const [confirm, setConfirm] = useState<{ files: ChangedFile[]; untracked: boolean } | null>(null)

  const groups = useMemo(() => {
    const files = status?.files ?? []
    return {
      conflicts: files.filter((f) => f.conflicted),
      staged: files.filter((f) => f.staged && !f.conflicted),
      changes: files.filter((f) => f.unstaged && !f.untracked && !f.conflicted),
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
  const open = (f: ChangedFile, staged: boolean, preview: boolean) =>
    openDiffTab({
      projectId,
      root: status.root,
      path: f.path,
      side: staged ? 'index' : 'worktree',
      preview,
    })

  const act = async (fn: Promise<unknown>) => {
    try {
      await fn
    } finally {
      onChanged()
    }
  }

  const confirmMessage = (c: { files: ChangedFile[]; untracked: boolean }) =>
    c.files.length === 1
      ? t('panel.discardConfirm', { path: c.files[0].path })
      : c.untracked
        ? t('git.deleteUntrackedConfirm', { n: c.files.length })
        : t('git.discardAllConfirm', { n: c.files.length })

  return (
    <>
      <CommitBox root={status.root} status={status} onChanged={onChanged} />
      {status.files.length === 0 && (
        <div className="empty">
          <div>{t('panel.noChanges')}</div>
          <div className="subtle">{t('panel.noChangesHint')}</div>
        </div>
      )}
      <FileGroup
        title={t('panel.conflicts')} files={groups.conflicts}
        actions={[]}
        // A conflict is resolved in the file itself, not in a diff.
        onOpen={(f, preview) => openFileTab({ projectId, root: status.root, path: f.path, preview })}
        rowAction={{
          icon: <Check size={12} />, label: t('conflicts.markResolved'),
          run: (f) => void act(gitStage(status.root, [f.path])),
        }}
      />
      <FileGroup
        title={t('panel.staged')} files={groups.staged}
        actions={[{
          icon: <Minus size={12} />, label: t('panel.unstageAll'),
          run: () => void act(gitUnstage(status.root, groups.staged.map((f) => f.path))),
        }]}
        onOpen={(f, preview) => open(f, true, preview)}
        rowAction={{
          icon: <Minus size={12} />, label: t('panel.unstage'),
          run: (f) => void act(gitUnstage(status.root, [f.path])),
        }}
      />
      <FileGroup
        title={t('panel.unstaged')} files={groups.changes}
        actions={[
          {
            icon: <Undo2 size={12} />, label: t('git.discardAll'),
            run: () => setConfirm({ files: groups.changes, untracked: false }),
          },
          {
            icon: <Plus size={12} />, label: t('panel.stageAll'),
            run: () => void act(gitStage(status.root, groups.changes.map((f) => f.path))),
          },
        ]}
        onOpen={(f, preview) => open(f, false, preview)}
        rowAction={{
          icon: <Plus size={12} />, label: t('panel.stage'),
          run: (f) => void act(gitStage(status.root, [f.path])),
        }}
        onDiscard={(f) => setConfirm({ files: [f], untracked: false })}
      />
      <FileGroup
        title={t('panel.untracked')} files={groups.untracked}
        actions={[
          {
            icon: <Trash2 size={12} />, label: t('git.deleteUntracked'),
            run: () => setConfirm({ files: groups.untracked, untracked: true }),
          },
          {
            icon: <Plus size={12} />, label: t('panel.stageAll'),
            run: () => void act(gitStage(status.root, groups.untracked.map((f) => f.path))),
          },
        ]}
        onOpen={(f, preview) => open(f, false, preview)}
        rowAction={{
          icon: <Plus size={12} />, label: t('panel.stage'),
          run: (f) => void act(gitStage(status.root, [f.path])),
        }}
        onDiscard={(f) => setConfirm({ files: [f], untracked: true })}
      />

      {confirm && (
        <ConfirmDialog
          title={confirm.files.length === 1 ? t('panel.discard') : confirm.untracked ? t('git.deleteUntracked') : t('git.discardAll')}
          message={confirmMessage(confirm)}
          confirmLabel={t('panel.discard')}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void act(gitDiscard(status.root, confirm.files.map((f) => f.path)))
            setConfirm(null)
          }}
        />
      )}
    </>
  )
}

function FileGroup({
  title, files, actions, onOpen, rowAction, onDiscard,
}: {
  title: string
  files: ChangedFile[]
  actions: Array<{ icon: React.ReactNode; label: string; run: () => void }>
  /** `preview` on a single click, as in VS Code; a double click keeps the file open. */
  onOpen: (f: ChangedFile, preview: boolean) => void
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
        {actions.map((a) => (
          <button
            key={a.label} className="icon-btn icon-btn--tiny" title={a.label} aria-label={a.label}
            onClick={a.run}
          >
            {a.icon}
          </button>
        ))}
      </header>
      {open && (
        <ul className="filelist">
          {files.map((f) => (
            <li
              key={`${title}-${f.path}`} className="filerow"
              onClick={() => onOpen(f, true)}
              onDoubleClick={() => onOpen(f, false)}
            >
              <span className={`filerow__code filerow__code--${codeClass(f)}`}>
                {f.code.trim() || '?'}
              </span>
              <FileIcon name={basename(f.path)} size={12} />
              <span className="filerow__name truncate">{basename(f.path)}</span>
              <span className="filerow__dir truncate subtle">{dirname(f.path)}</span>
              {/* Clicking these twice fast must not pin the file's diff. */}
              <span className="filerow__actions" onDoubleClick={(e) => e.stopPropagation()}>
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
/** The folder holding an absolute path, whichever separator the platform uses. */
const parentDir = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p.slice(0, i + 1) || p : p.slice(0, i)
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
  const addTerminalTab = useWorkspace((s) => s.addTerminalTab)
  const [filter, setFilter] = useState('')
  /** The last "expand/collapse all"; every folder follows it, see TreeNode. */
  const [treeCommand, setTreeCommand] = useState<{ open: boolean; nonce: number } | null>(null)
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
      void findFiles(root, q, 300, settings.panel.showHidden, settings.panel.respectGitignore)
        .then(setResults)
        .catch(() => setResults([]))
    }, 160)
    return () => window.clearTimeout(id)
  }, [filter, root, settings.panel.showHidden, settings.panel.respectGitignore])

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
          className="icon-btn"
          title={treeCommand?.open ? t('panel.collapseAll') : t('panel.expandAll')}
          aria-label={treeCommand?.open ? t('panel.collapseAll') : t('panel.expandAll')}
          onClick={() =>
            setTreeCommand((c) => ({ open: !c?.open, nonce: (c?.nonce ?? 0) + 1 }))
          }
        >
          {treeCommand?.open ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
        </button>
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
                  onClick={() => openFileTab({ projectId, root, path: e.rel, preview: true })}
                  onDoubleClick={() => openFileTab({ projectId, root, path: e.rel })}
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
            revision={revision} defaultOpen command={treeCommand}
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
        <MenuItem
          icon={<Terminal size={13} />} label={t('fs.openTerminal')}
          onClick={() => {
            const { path, isDir } = menu!.target
            setMenu(null)
            // A folder opens in itself, a file in the folder that holds it.
            addTerminalTab({ projectId, kind: 'shell', cwd: isDir ? path : parentDir(path) })
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
            void run(createFile(join(dialog.dir, name), root))
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
            void run(createDir(join(dialog.dir, name), root))
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
            void run(renamePath(dialog.target.path, join(parent, name), root))
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
            void run(trashPath(path, root))
          }}
        />
      )}
    </div>
  )
}

function TreeNode({
  projectId, root, dir, depth, name, defaultOpen, revision, command, onContext,
}: {
  projectId: string; root: string; dir: string; depth: number
  name?: string; defaultOpen?: boolean; revision: number
  /** Expand or collapse every folder; `nonce` makes the same command count again. */
  command?: { open: boolean; nonce: number } | null
  onContext: (target: FsTarget, anchor: HTMLElement) => void
}) {
  const settings = useSettings((s) => s.settings)
  const openFileTab = useWorkspace((s) => s.openFileTab)
  const [open, setOpen] = useState(!!defaultOpen)
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null)
  const loadedFor = useRef('')
  /** The last command carried out, so it is not carried out twice. */
  const applied = useRef(0)

  // A folder that appears after "expand all" follows it too: that is what
  // unfolds the whole tree as each listing arrives.
  useEffect(() => {
    if (!command || command.nonce === applied.current) return
    applied.current = command.nonce
    // The root has no row of its own to open again from.
    if (name !== undefined) setOpen(command.open)
  }, [command, name])

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
              depth={childDepth} name={e.name} revision={revision} command={command}
              onContext={onContext}
            />
          ) : (
            <button
              key={e.path} className="treerow"
              style={{ paddingLeft: 6 + childDepth * 12 + 14 }}
              // A click previews the file, a double click keeps it open, as in VS Code.
              onClick={() => openFileTab({ projectId, root, path: e.rel, preview: true })}
              onDoubleClick={() => openFileTab({ projectId, root, path: e.rel })}
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
