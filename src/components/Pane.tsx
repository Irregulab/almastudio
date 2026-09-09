import { useCallback, useMemo, useRef, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Bot, Columns2, FileDiff, FileText, FolderOpen, Loader2, PanelsTopLeft, Plus,
  RotateCw, Rows2, Sparkles, Square, SquareTerminal, Terminal, X,
} from 'lucide-react'

import { ptyKill } from '../lib/ipc'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { defaultTabTitle } from '../lib/harness'
import { TerminalView } from './TerminalView'
import { DiffView } from './DiffView'
import { FileView } from './FileView'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover } from './ui'
import { allLeaves } from '../lib/layout'
import type {
  HarnessKind, LeafNode, Tab, TerminalStatus, TerminalTab,
} from '../lib/types'
import { isTerminalTab } from '../lib/types'

const MIME = 'application/x-almastudio-tab'

export function tabIcon(kind: Tab['kind'], size = 13) {
  switch (kind) {
    case 'claude': return <Sparkles size={size} />
    case 'codex': return <Bot size={size} />
    case 'shell': return <Terminal size={size} />
    case 'diff': return <FileDiff size={size} />
    case 'file': return <FileText size={size} />
  }
}

export function Pane({ leaf }: { leaf: LeafNode }) {
  const tabsById = useWorkspace((s) => s.tabs)
  const activePaneId = useWorkspace(
    (s) => (s.activeProjectId ? s.workspaces[s.activeProjectId]?.activePaneId : null),
  )
  const setActivePane = useWorkspace((s) => s.setActivePane)
  const isActive = activePaneId === leaf.id

  const tabs = useMemo(
    () => leaf.tabIds.map((id) => tabsById[id]).filter(Boolean),
    [leaf.tabIds, tabsById],
  )

  return (
    <div
      className={`pane${isActive ? ' pane--active' : ''}`}
      onMouseDownCapture={() => !isActive && setActivePane(leaf.id)}
    >
      <TabBar leaf={leaf} tabs={tabs} />
      <div className="pane__body">
        {tabs.map((tab) => (
          <div key={tab.id} className="pane__content" hidden={tab.id !== leaf.activeTabId}>
            <TabContent
              tab={tab}
              visible={tab.id === leaf.activeTabId}
              focused={isActive && tab.id === leaf.activeTabId}
            />
          </div>
        ))}
        {tabs.length === 0 && <EmptyPane paneId={leaf.id} />}
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
  return <FileView tab={tab} visible={visible} />
}

// ------------------------------------------------------------------ tabs ---

function TabBar({ leaf, tabs }: { leaf: LeafNode; tabs: Tab[] }) {
  const t = useT()
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const moveTab = useWorkspace((s) => s.moveTab)
  const dirtyTabs = useUi((s) => s.dirtyTabs)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState<Tab | null>(null)

  const requestClose = (tab: Tab) => {
    if (dirtyTabs[tab.id]) setConfirmClose(tab)
    else closeTab(tab.id)
  }

  const onDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDropIndex(null)
    const tabId = e.dataTransfer.getData(MIME)
    if (tabId) moveTab(tabId, leaf.id, index)
  }

  return (
    <div
      className="tabbar"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MIME)) e.preventDefault()
      }}
      onDrop={(e) => onDrop(e, tabs.length)}
    >
      <div className="tabbar__tabs">
        {tabs.map((tab, i) => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={tab.id === leaf.activeTabId}
            dropBefore={dropIndex === i}
            onSelect={() => setActiveTab(leaf.id, tab.id)}
            onClose={() => requestClose(tab)}
            onDragOverChip={(before) => setDropIndex(before ? i : i + 1)}
            onDropChip={(e, before) => onDrop(e, before ? i : i + 1)}
            paneId={leaf.id}
          />
        ))}
      </div>
      <PaneActions leaf={leaf} />

      {confirmClose && (
        <ConfirmDialog
          title={t('editor.discardTitle')}
          message={t('editor.discardBody', {
            name: confirmClose.title || (isTerminalTab(confirmClose) ? '' : confirmClose.path),
          })}
          confirmLabel={t('editor.closeAnyway')}
          danger
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            closeTab(confirmClose.id)
            setConfirmClose(null)
          }}
        />
      )}
    </div>
  )
}

function TabChip({
  tab, active, dropBefore, onSelect, onClose, onDragOverChip, onDropChip, paneId,
}: {
  tab: Tab
  active: boolean
  dropBefore: boolean
  onSelect: () => void
  onClose: () => void
  onDragOverChip: (before: boolean) => void
  onDropChip: (e: React.DragEvent, before: boolean) => void
  paneId: string
}) {
  const t = useT()
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab.projectId))
  const renameTab = useWorkspace((s) => s.renameTab)
  const setTabCwd = useWorkspace((s) => s.setTabCwd)
  const splitPane = useWorkspace((s) => s.splitPane)
  const closeOtherTabs = useWorkspace((s) => s.closeOtherTabs)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const label = tab.title || autoTitle(tab, project?.root)
  const status = isTerminalTab(tab) ? tab.status : undefined
  const busy = useUi((s) => !!s.busyTabs[tab.id])
  const dirty = useUi((s) => !!s.dirtyTabs[tab.id])

  const changeFolder = useCallback(async () => {
    if (!isTerminalTab(tab)) return
    const picked = await openDialog({ directory: true, defaultPath: tab.cwd })
    if (typeof picked === 'string') setTabCwd(tab.id, picked)
  }, [setTabCwd, tab])

  return (
    <>
      <div
        ref={ref}
        className={`tab${active ? ' tab--active' : ''}${dropBefore ? ' tab--drop' : ''}`}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(MIME, tab.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(MIME)) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onDragOverChip(e.clientX < r.left + r.width / 2)
        }}
        onDrop={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onDropChip(e, e.clientX < r.left + r.width / 2)
        }}
        onClick={onSelect}
        onDoubleClick={() => setRenaming(true)}
        onAuxClick={(e) => e.button === 1 && onClose()}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAnchor(ref.current)
        }}
        title={isTerminalTab(tab) ? tab.cwd : tab.path}
      >
        <span className={`tab__icon tab__icon--${tab.kind}`}>{tabIcon(tab.kind)}</span>
        {renaming ? (
          <input
            className="tab__rename"
            defaultValue={label}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renameTab(tab.id, e.target.value.trim() || label)
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="tab__label truncate">{label}</span>
        )}
        {status && <TabStatus status={status} busy={busy} />}
        <button
          className={`tab__close${dirty ? ' tab__close--dirty' : ''}`}
          aria-label={dirty ? t('editor.unsaved') : t('tabs.close')}
          title={dirty ? t('editor.unsaved') : t('tabs.close')}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          {dirty ? <span className="tab__dirty" aria-hidden /> : <X size={12} />}
        </button>
      </div>

      <Popover anchor={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <MenuItem label={t('tabs.rename')} onClick={() => { setMenuAnchor(null); setRenaming(true) }} />
        {isTerminalTab(tab) && (
          <>
            <MenuItem
              icon={<FolderOpen size={13} />}
              label={t('tabs.changeFolder')}
              onClick={() => { setMenuAnchor(null); void changeFolder() }}
            />
            <MenuSeparator />
            <MenuItem
              icon={<RotateCw size={13} />}
              label={t('tabs.restart')}
              onClick={() => {
                setMenuAnchor(null)
                // The TerminalView owns the session; ask it to respawn.
                window.dispatchEvent(
                  new CustomEvent('almastudio:tab-restart', { detail: tab.id }),
                )
              }}
            />
            <MenuItem
              icon={<Square size={13} />}
              label={t('tabs.stop')}
              disabled={tab.status !== 'running' && tab.status !== 'starting'}
              onClick={() => { setMenuAnchor(null); void ptyKill(tab.id).catch(() => {}) }}
            />
          </>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Columns2 size={13} />}
          label={t('tabs.splitRight')}
          onClick={() => { setMenuAnchor(null); splitPane(paneId, 'row', tab.id) }}
        />
        <MenuItem
          icon={<Rows2 size={13} />}
          label={t('tabs.splitDown')}
          onClick={() => { setMenuAnchor(null); splitPane(paneId, 'col', tab.id) }}
        />
        <MenuSeparator />
        <MenuItem
          label={t('tabs.closeOthers')}
          onClick={() => { setMenuAnchor(null); closeOtherTabs(paneId, tab.id) }}
        />
        <MenuItem label={t('tabs.close')} danger onClick={() => { setMenuAnchor(null); onClose() }} />
      </Popover>
    </>
  )
}

const KIND_LABEL: Record<HarnessKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal',
}

/**
 * What the harness is doing, at a glance: spinning while it produces output,
 * a solid accent dot when it has gone quiet and is waiting on you, and a
 * muted or red dot when it is not running at all.
 */
function TabStatus({ status, busy }: { status: TerminalStatus; busy: boolean }) {
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
  if (!isTerminalTab(tab)) return tab.path.split('/').pop() ?? tab.path
  return defaultTabTitle(tab.cwd, projectRoot, KIND_LABEL[tab.kind])
}

// --------------------------------------------------------- pane actions ----

function PaneActions({ leaf }: { leaf: LeafNode }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const splitPane = useWorkspace((s) => s.splitPane)
  const closePane = useWorkspace((s) => s.closePane)
  // A pane can only be dissolved while another one exists to absorb the space.
  const isSplit = useWorkspace((s) => {
    const ws = s.activeProjectId ? s.workspaces[s.activeProjectId] : undefined
    return ws ? allLeaves(ws.layout).length > 1 : false
  })
  const newTab = useNewTab()

  return (
    <div className="tabbar__actions">
      <button
        className="icon-btn"
        aria-label={t('tabs.new')}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <Plus size={15} />
      </button>
      <button
        className="icon-btn"
        aria-label={t('tabs.splitRight')}
        onClick={() => splitPane(leaf.id, 'row')}
      >
        <Columns2 size={14} />
      </button>
      <button
        className="icon-btn"
        aria-label={t('tabs.splitDown')}
        onClick={() => splitPane(leaf.id, 'col')}
      >
        <Rows2 size={14} />
      </button>
      {isSplit && (
        <button
          className="icon-btn"
          aria-label={t('menu.closePane')}
          title={t('menu.closePane')}
          onClick={() => closePane(leaf.id)}
        >
          <PanelsTopLeft size={14} />
        </button>
      )}

      <Popover anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)} align="end">
        <MenuItem
          icon={<Sparkles size={13} />}
          label={t('tabs.claude')}
          hint="⌘N"
          onClick={() => { setAnchor(null); void newTab('claude', leaf.id) }}
        />
        <MenuItem
          icon={<Bot size={13} />}
          label={t('tabs.codex')}
          hint="⇧⌘C"
          onClick={() => { setAnchor(null); void newTab('codex', leaf.id) }}
        />
        <MenuItem
          icon={<Terminal size={13} />}
          label={t('tabs.shell')}
          hint="⌘T"
          onClick={() => { setAnchor(null); void newTab('shell', leaf.id) }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<FolderOpen size={13} />}
          label={t('menu.openFolder')}
          hint="⌘O"
          onClick={() => { setAnchor(null); void newTab(undefined, leaf.id, true) }}
        />
      </Popover>
    </div>
  )
}

function EmptyPane({ paneId }: { paneId: string }) {
  const t = useT()
  const newTab = useNewTab()
  const closePane = useWorkspace((s) => s.closePane)
  const isSplit = useWorkspace((s) => {
    const ws = s.activeProjectId ? s.workspaces[s.activeProjectId] : undefined
    return ws ? allLeaves(ws.layout).length > 1 : false
  })
  return (
    <div className="empty">
      <SquareTerminal size={26} />
      <div>
        <div style={{ fontWeight: 600, color: 'var(--fg-muted)' }}>{t('tabs.noTabs')}</div>
        <div style={{ marginTop: 4 }}>{t('tabs.noTabsHint')}</div>
      </div>
      <div className="row">
        <button className="btn btn--sm" onClick={() => void newTab('claude', paneId)}>
          <Sparkles size={13} /> {t('tabs.claude')}
        </button>
        <button className="btn btn--sm" onClick={() => void newTab('codex', paneId)}>
          <Bot size={13} /> {t('tabs.codex')}
        </button>
        <button className="btn btn--sm" onClick={() => void newTab('shell', paneId)}>
          <Terminal size={13} /> {t('tabs.shell')}
        </button>
      </div>
      {isSplit && (
        <button className="btn btn--ghost btn--sm" onClick={() => closePane(paneId)}>
          <X size={13} /> {t('menu.closePane')}
        </button>
      )}
    </div>
  )
}

/** Opens a tab in the given pane, optionally asking for a folder first. */
export function useNewTab() {
  const addTerminalTab = useWorkspace((s) => s.addTerminalTab)
  const settings = useSettings((s) => s.settings)

  return useCallback(
    async (kind?: HarnessKind, paneId?: string, pickFolder = false) => {
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
      addTerminalTab({ projectId, kind: resolved, cwd, paneId })
    },
    [addTerminalTab, settings.defaultHarness],
  )
}

export type { TerminalTab }
