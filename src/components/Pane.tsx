import { useCallback, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Bot, ChevronDown, Columns2, FileDiff, FileText, FolderOpen, GitGraph, Globe, Loader2,
  PanelsTopLeft, RotateCw, Rows2, Sparkles, Square, SquareCode, Terminal, X,
} from 'lucide-react'

import { ptyKill } from '../lib/ipc'
import { useDrag } from '../lib/dragDrop'
import { defaultTabTitle } from '../lib/harness'
import { isLeaf } from '../lib/layout'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { TerminalView } from './TerminalView'
import { BrowserView } from './BrowserView'
import { DiffView } from './DiffView'
import { FileView } from './FileView'
import { GitGraphView } from './GitGraphView'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover } from './ui'
import type { HarnessKind, LeafNode, Tab, TabGroup, TerminalStatus } from '../lib/types'
import { isTerminalTab } from '../lib/types'

export function tabIcon(kind: Tab['kind'], size = 13) {
  switch (kind) {
    case 'claude': return <Sparkles size={size} />
    case 'codex': return <Bot size={size} />
    case 'opencode': return <SquareCode size={size} />
    case 'shell': return <Terminal size={size} />
    case 'diff': return <FileDiff size={size} />
    case 'file': return <FileText size={size} />
    case 'browser': return <Globe size={size} />
    case 'graph': return <GitGraph size={size} />
  }
}

/**
 * One pane of a tab: a single session. Once its tab is split it gets a header
 * of its own, since the tab strip then names only the focused one.
 */
export function Pane({ leaf, group, visible }: { leaf: LeafNode; group: TabGroup; visible: boolean }) {
  const tab = useWorkspace((s) => s.tabs[leaf.tabId])
  const setActivePane = useWorkspace((s) => s.setActivePane)
  const focused = group.activePaneId === leaf.id
  const split = !isLeaf(group.layout)
  // A primitive, so a moving pointer only re-renders the pane it enters or leaves.
  const zone = useDrag((s) =>
    s.target?.kind === 'pane' && s.target.paneId === leaf.id ? s.target.zone : null,
  )

  if (!tab) return <div className="pane" />
  return (
    <div
      className={`pane${split && focused ? ' pane--active' : ''}`}
      onMouseDownCapture={() => !focused && setActivePane(leaf.id)}
    >
      {split && <PaneHeader tab={tab} leaf={leaf} focused={focused} />}
      <div className="pane__body" data-drop-pane data-pane-id={leaf.id}>
        <div className="pane__content">
          <TabContent tab={tab} visible={visible} focused={visible && focused} />
        </div>
        {/* Only the edges mean something: a tab dropped there joins this split. */}
        {zone && zone !== 'center' && <div className={`dropzone dropzone--${zone}`} aria-hidden />}
      </div>
    </div>
  )
}

function TabContent({
  tab, visible, focused,
}: { tab: Tab; visible: boolean; focused: boolean }) {
  if (isTerminalTab(tab)) {
    return <TerminalView tab={tab} visible={visible} focused={focused} />
  }
  if (tab.kind === 'diff') return <DiffView tab={tab} visible={visible} />
  if (tab.kind === 'browser') return <BrowserView tab={tab} visible={visible} />
  if (tab.kind === 'graph') return <GitGraphView tab={tab} visible={visible} />
  return <FileView tab={tab} visible={visible} />
}

function PaneHeader({ tab, leaf, focused }: { tab: Tab; leaf: LeafNode; focused: boolean }) {
  const t = useT()
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab.projectId))
  const splitPane = useWorkspace((s) => s.splitPane)
  const movePaneToNewGroup = useWorkspace((s) => s.movePaneToNewGroup)
  const busy = useUi((s) => !!s.busyTabs[tab.id])
  const { request, dialog } = useGuardedClose()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const label = sessionLabel(tab, project?.root)
  const close = () => request([tab.id], label)
  const pick = (fn: () => void) => () => {
    setMenuAnchor(null)
    fn()
  }

  return (
    <div
      className={`pane__head${focused ? ' pane__head--focused' : ''}`}
      onDoubleClick={() => setRenaming(true)}
      title={tabTooltip(tab)}
    >
      <span className={`tab__icon tab__icon--${tab.kind}`}>{tabIcon(tab.kind, 12)}</span>
      {renaming ? (
        <RenameInput tab={tab} label={label} onDone={() => setRenaming(false)} />
      ) : (
        <span className="pane__title truncate">{label}</span>
      )}
      {isTerminalTab(tab) && <TabStatus status={tab.status} busy={busy} />}
      <span className="spacer" />
      <button
        className="icon-btn icon-btn--tiny"
        aria-label={t('tabs.paneMenu')}
        onClick={(e) => setMenuAnchor(e.currentTarget)}
      >
        <ChevronDown size={12} />
      </button>
      <button
        className="icon-btn icon-btn--tiny"
        aria-label={t('menu.closePane')}
        title={t('menu.closePane')}
        onClick={close}
      >
        <X size={12} />
      </button>

      <Popover anchor={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)} align="end">
        <SessionMenuItems tab={tab} onPick={() => setMenuAnchor(null)} onRename={() => setRenaming(true)} />
        <MenuSeparator />
        <MenuItem
          icon={<Columns2 size={13} />}
          label={t('tabs.splitRight')}
          onClick={pick(() => splitPane(leaf.id, 'row'))}
        />
        <MenuItem
          icon={<Rows2 size={13} />}
          label={t('tabs.splitDown')}
          onClick={pick(() => splitPane(leaf.id, 'col'))}
        />
        <MenuItem
          icon={<PanelsTopLeft size={13} />}
          label={t('tabs.moveToNewTab')}
          onClick={pick(() => movePaneToNewGroup(leaf.id))}
        />
        <MenuSeparator />
        <MenuItem label={t('menu.closePane')} danger onClick={pick(close)} />
      </Popover>
      {dialog}
    </div>
  )
}

/** Inline rename for a session's title. */
export function RenameInput({ tab, label, onDone }: { tab: Tab; label: string; onDone: () => void }) {
  const renameTab = useWorkspace((s) => s.renameTab)
  return (
    <input
      className="tab__rename"
      defaultValue={label}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      // Selecting text in the field must not start dragging the tab.
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        renameTab(tab.id, e.target.value.trim() || label)
        onDone()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') onDone()
      }}
    />
  )
}

/** Menu entries for one session: rename, and for a terminal its folder and process. */
export function SessionMenuItems({
  tab, onPick, onRename,
}: { tab: Tab; onPick: () => void; onRename: () => void }) {
  const t = useT()
  const setTabCwd = useWorkspace((s) => s.setTabCwd)

  const changeFolder = async () => {
    if (!isTerminalTab(tab)) return
    const picked = await openDialog({ directory: true, defaultPath: tab.cwd })
    if (typeof picked === 'string') setTabCwd(tab.id, picked)
  }

  return (
    <>
      <MenuItem label={t('tabs.rename')} onClick={() => { onPick(); onRename() }} />
      {isTerminalTab(tab) && (
        <>
          <MenuItem
            icon={<FolderOpen size={13} />}
            label={t('tabs.changeFolder')}
            onClick={() => { onPick(); void changeFolder() }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<RotateCw size={13} />}
            label={t('tabs.restart')}
            onClick={() => {
              onPick()
              // The TerminalView owns the session; ask it to respawn.
              window.dispatchEvent(new CustomEvent('almastudio:tab-restart', { detail: tab.id }))
            }}
          />
          <MenuItem
            icon={<Square size={13} />}
            label={t('tabs.stop')}
            disabled={tab.status !== 'running' && tab.status !== 'starting'}
            onClick={() => { onPick(); void ptyKill(tab.id).catch(() => {}) }}
          />
        </>
      )}
    </>
  )
}

/** Closes sessions, asking first when any of them has unsaved edits. */
export function useGuardedClose() {
  const t = useT()
  const closeTab = useWorkspace((s) => s.closeTab)
  const [pending, setPending] = useState<{ ids: string[]; name: string } | null>(null)

  const request = useCallback(
    (ids: string[], name: string) => {
      const dirty = useUi.getState().dirtyTabs
      if (ids.some((id) => dirty[id])) setPending({ ids, name })
      else for (const id of ids) closeTab(id)
    },
    [closeTab],
  )

  const dialog = pending && (
    <ConfirmDialog
      title={t('editor.discardTitle')}
      message={t('editor.discardBody', { name: pending.name })}
      confirmLabel={t('editor.closeAnyway')}
      danger
      onCancel={() => setPending(null)}
      onConfirm={() => {
        for (const id of pending.ids) closeTab(id)
        setPending(null)
      }}
    />
  )
  return { request, dialog }
}

const KIND_LABEL: Record<HarnessKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  shell: 'Terminal',
}

/**
 * What the harness is doing, at a glance: spinning while it produces output,
 * a solid accent dot when it has gone quiet and is waiting on you, and a
 * muted or red dot when it is not running at all.
 */
export function TabStatus({ status, busy }: { status: TerminalStatus; busy: boolean }) {
  const t = useT()
  if (status === 'running' || status === 'starting') {
    return busy ? (
      <Loader2 size={11} className="tab__spinner" aria-label={t('tabs.working')} />
    ) : (
      <span className="tab__dot tab__dot--waiting" title={t('tabs.waiting')} aria-hidden />
    )
  }
  return <span className={`tab__dot tab__dot--${status}`} aria-hidden />
}

function autoTitle(tab: Tab, projectRoot: string | undefined): string {
  if (isTerminalTab(tab)) return defaultTabTitle(tab.cwd, projectRoot, KIND_LABEL[tab.kind])
  if (tab.kind === 'browser') return hostOf(tab.url)
  if (tab.kind === 'graph') return `Git Graph · ${tab.root.split(/[/\\]/).filter(Boolean).pop() ?? tab.root}`
  return tab.path.split('/').pop() ?? tab.path
}

/** A session's name: the user's, or one derived from what it shows. */
export const sessionLabel = (tab: Tab, projectRoot: string | undefined) =>
  tab.title || autoTitle(tab, projectRoot)

export function tabTooltip(tab: Tab): string {
  if (isTerminalTab(tab)) return tab.cwd
  if (tab.kind === 'browser') return tab.url
  return tab.kind === 'graph' ? tab.root : tab.path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Opens a new tab running a harness, optionally asking for a folder first. */
export function useNewTab() {
  const addTerminalTab = useWorkspace((s) => s.addTerminalTab)
  const settings = useSettings((s) => s.settings)

  return useCallback(
    async (kind?: HarnessKind, pickFolder = false) => {
      const s = useWorkspace.getState()
      const projectId = s.activeProjectId
      if (!projectId) return
      const project = s.projects.find((p) => p.id === projectId)
      if (!project) return

      let cwd = project.root
      if (pickFolder) {
        const picked = await openDialog({ directory: true, defaultPath: project.root })
        if (typeof picked !== 'string') return
        cwd = picked
      }
      const resolved: HarnessKind =
        kind ??
        (project.defaultHarness === 'default' ? settings.defaultHarness : project.defaultHarness)
      addTerminalTab({ projectId, kind: resolved, cwd })
    },
    [addTerminalTab, settings.defaultHarness],
  )
}
