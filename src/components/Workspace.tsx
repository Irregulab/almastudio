import { useEffect, useRef, useState } from 'react'
import { message } from '@tauri-apps/plugin-dialog'
import {
  Bot, Braces, CodeXml, Columns2, FolderOpen, Globe, Plus, Rows2, Sparkles, SquareCode,
  SquareTerminal, Terminal, X,
} from 'lucide-react'

import { externalEditors, openInEditor, type ExternalEditor } from '../lib/ipc'

import { beginPointerDrag, useDrag } from '../lib/dragDrop'
import { allLeaves, allTabIds, findLeaf } from '../lib/layout'
import { useInstalledHarnesses } from '../hooks/useInstalledHarnesses'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { TileNode } from './Tiles'
import {
  RenameInput, SessionMenuItems, TabStatus, isPreview, sessionLabel, tabIcon, tabTooltip,
  useGuardedClose, useNewTab,
} from './Pane'
import { MenuItem, MenuSeparator, Popover } from './ui'
import type { ProjectWorkspace, TabGroup } from '../lib/types'
import { isTerminalTab } from '../lib/types'

/**
 * A project's tabs: the strip across the top and, below it, the tab in front.
 * Every tab stays mounted — hidden, not unmounted — so terminals in the
 * background keep running and keep their scrollback. The same goes for the
 * project itself while another is `active` in front of it.
 */
export function Workspace({ projectId, active }: { projectId: string; active: boolean }) {
  const ws = useWorkspace((s) => s.workspaces[projectId])
  if (!ws) return null
  return (
    <div className="workspace" hidden={!active}>
      <TabStrip ws={ws} />
      <div className="workspace__body">
        {ws.groups.length === 0 && <EmptyWorkspace />}
        {ws.groups.map((g) => (
          <div key={g.id} className="workspace__group" hidden={g.id !== ws.activeGroupId}>
            <TileNode node={g.layout} group={g} visible={active && g.id === ws.activeGroupId} />
          </div>
        ))}
      </div>
    </div>
  )
}

function TabStrip({ ws }: { ws: ProjectWorkspace }) {
  const dropIndex = useDrag((s) => (s.target?.kind === 'tab-slot' ? s.target.index : null))
  const n = ws.groups.length
  return (
    // Anywhere on the strip outside a chip means "put it last".
    <div className="tabbar" data-drop-tabbar data-count={n}>
      <div className="tabbar__tabs">
        {ws.groups.map((g, i) => (
          <GroupChip
            key={g.id}
            group={g}
            index={i}
            active={g.id === ws.activeGroupId}
            dropBefore={dropIndex === i}
            dropAfter={dropIndex === n && i === n - 1}
          />
        ))}
      </div>
      <TabActions ws={ws} />
    </div>
  )
}

/**
 * A tab in the strip. It is named after its focused session and, once split,
 * shows how many panes it holds.
 */
function GroupChip({
  group, index, active, dropBefore, dropAfter,
}: { group: TabGroup; index: number; active: boolean; dropBefore: boolean; dropAfter: boolean }) {
  const t = useT()
  const front = findLeaf(group.layout, group.activePaneId) ?? allLeaves(group.layout)[0]
  const tab = useWorkspace((s) => s.tabs[front.tabId])
  const project = useWorkspace((s) => s.projects.find((p) => p.id === tab?.projectId))
  const setActiveGroup = useWorkspace((s) => s.setActiveGroup)
  const splitPane = useWorkspace((s) => s.splitPane)
  const closeOtherGroups = useWorkspace((s) => s.closeOtherGroups)
  const pinTab = useWorkspace((s) => s.pinTab)
  const dirty = useUi((s) => allTabIds(group.layout).some((id) => s.dirtyTabs[id]))
  const busy = useUi((s) => !!s.busyTabs[front.tabId])
  const { request, dialog } = useGuardedClose()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (!tab) return null
  const panes = allLeaves(group.layout).length
  const label = sessionLabel(tab, project?.root)
  const close = () => request(allTabIds(group.layout), label)
  const pick = (fn: () => void) => () => {
    setMenuAnchor(null)
    fn()
  }

  return (
    <>
      <div
        ref={ref}
        className={`tab${active ? ' tab--active' : ''}${dropBefore ? ' tab--drop' : ''}${
          dropAfter ? ' tab--drop-after' : ''
        }${isPreview(tab) ? ' tab--preview' : ''}`}
        data-drop-tab-chip
        data-index={index}
        onPointerDown={(e) => {
          if (!renaming) beginPointerDrag(e, { kind: 'tab', id: group.id, label })
        }}
        onClick={() => setActiveGroup(group.id)}
        // Double-clicking a preview keeps it open, as in VS Code; rename is in its menu.
        onDoubleClick={() => (isPreview(tab) ? pinTab(tab.id) : setRenaming(true))}
        onAuxClick={(e) => e.button === 1 && close()}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAnchor(ref.current)
        }}
        title={tabTooltip(tab)}
      >
        <span className={`tab__icon tab__icon--${tab.kind}`}>{tabIcon(tab.kind)}</span>
        {renaming ? (
          <RenameInput tab={tab} label={label} onDone={() => setRenaming(false)} />
        ) : (
          <span className="tab__label truncate">{label}</span>
        )}
        {panes > 1 && (
          <span className="tab__panes" title={t('tabs.panes', { n: panes })}>{panes}</span>
        )}
        {isTerminalTab(tab) && <TabStatus status={tab.status} busy={busy} />}
        <button
          className={`tab__close${dirty ? ' tab__close--dirty' : ''}`}
          aria-label={dirty ? t('editor.unsaved') : t('tabs.close')}
          title={dirty ? t('editor.unsaved') : t('tabs.close')}
          onClick={(e) => {
            e.stopPropagation()
            close()
          }}
        >
          {dirty ? <span className="tab__dirty" aria-hidden /> : <X size={12} />}
        </button>
      </div>

      <Popover anchor={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <SessionMenuItems tab={tab} onPick={() => setMenuAnchor(null)} onRename={() => setRenaming(true)} />
        <MenuSeparator />
        <MenuItem
          icon={<Columns2 size={13} />}
          label={t('tabs.splitRight')}
          onClick={pick(() => splitPane(front.id, 'row'))}
        />
        <MenuItem
          icon={<Rows2 size={13} />}
          label={t('tabs.splitDown')}
          onClick={pick(() => splitPane(front.id, 'col'))}
        />
        <MenuSeparator />
        <MenuItem label={t('tabs.closeOthers')} onClick={pick(() => closeOtherGroups(group.id))} />
        <MenuItem label={t('tabs.close')} danger onClick={pick(close)} />
      </Popover>
      {dialog}
    </>
  )
}

/** New tab, and splitting the tab in front, at the end of the strip. */
function TabActions({ ws }: { ws: ProjectWorkspace }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const splitPane = useWorkspace((s) => s.splitPane)
  const front = ws.groups.find((g) => g.id === ws.activeGroupId)
  const split = (dir: 'row' | 'col') => front && splitPane(front.activePaneId, dir)

  return (
    <div className="tabbar__actions">
      <button className="icon-btn" aria-label={t('tabs.new')} onClick={(e) => setAnchor(e.currentTarget)}>
        <Plus size={15} />
      </button>
      <button
        className="icon-btn"
        aria-label={t('tabs.splitRight')}
        title={`${t('tabs.splitRight')} (⌘D)`}
        disabled={!front}
        onClick={() => split('row')}
      >
        <Columns2 size={14} />
      </button>
      <button
        className="icon-btn"
        aria-label={t('tabs.splitDown')}
        title={`${t('tabs.splitDown')} (⇧⌘D)`}
        disabled={!front}
        onClick={() => split('col')}
      >
        <Rows2 size={14} />
      </button>

      <Popover anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)} align="end">
        <NewTabMenuItems onPick={() => setAnchor(null)} />
      </Popover>
    </div>
  )
}

/**
 * The editors found installed, as last looked up. The menu shows these at
 * once and looks again each time it opens, so an editor installed while the
 * app runs still turns up.
 */
let knownEditors: ExternalEditor[] = []
void externalEditors().then((list) => (knownEditors = list)).catch(() => {})

function useExternalEditors() {
  const [editors, setEditors] = useState(knownEditors)
  useEffect(() => {
    let live = true
    void externalEditors()
      .then((list) => {
        knownEditors = list
        if (live) setEditors(list)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return editors
}

function NewTabMenuItems({ onPick }: { onPick: () => void }) {
  const t = useT()
  const newTab = useNewTab()
  const editors = useExternalEditors()
  const harnesses = useInstalledHarnesses()
  const pick = (fn: () => void) => () => {
    onPick()
    fn()
  }
  return (
    <>
      {harnesses.includes('claude') && (
        <MenuItem icon={<Sparkles size={13} />} label={t('tabs.claude')} hint="⌘N" onClick={pick(() => void newTab('claude'))} />
      )}
      {harnesses.includes('codex') && (
        <MenuItem icon={<Bot size={13} />} label={t('tabs.codex')} hint="⇧⌘C" onClick={pick(() => void newTab('codex'))} />
      )}
      {harnesses.includes('opencode') && (
        <MenuItem icon={<SquareCode size={13} />} label={t('tabs.opencode')} hint="⇧⌘O" onClick={pick(() => void newTab('opencode'))} />
      )}
      <MenuItem icon={<Terminal size={13} />} label={t('tabs.shell')} hint="⌘T" onClick={pick(() => void newTab('shell'))} />
      <MenuItem icon={<Globe size={13} />} label={t('tabs.browser')} onClick={pick(openBrowser)} />
      <MenuSeparator />
      <MenuItem
        icon={<FolderOpen size={13} />}
        label={t('menu.openFolder')}
        hint="⌘O"
        onClick={pick(() => void newTab(undefined, true))}
      />
      {editors.length > 0 && <MenuSeparator />}
      {editors.map((editor) => (
        <MenuItem
          key={editor.id}
          icon={editor.id === 'intellij' ? <Braces size={13} /> : <CodeXml size={13} />}
          label={t('editors.openIn', { name: editor.name })}
          onClick={pick(() => void openProjectIn(editor, t))}
        />
      ))}
    </>
  )
}

function openBrowser() {
  const s = useWorkspace.getState()
  if (s.activeProjectId) s.openBrowserTab({ projectId: s.activeProjectId })
}

/** The project folder in an installed editor, in the editor's own window. */
async function openProjectIn(editor: ExternalEditor, t: ReturnType<typeof useT>) {
  const s = useWorkspace.getState()
  const project = s.projects.find((p) => p.id === s.activeProjectId)
  if (!project) return
  try {
    await openInEditor(editor.id, project.root)
  } catch (e) {
    await message(t('editors.failed', { name: editor.name, error: String(e) }), {
      title: editor.name,
      kind: 'error',
    })
  }
}

function EmptyWorkspace() {
  const t = useT()
  const newTab = useNewTab()
  const harnesses = useInstalledHarnesses()
  return (
    <div className="empty">
      <SquareTerminal size={26} />
      <div>
        <div style={{ fontWeight: 600, color: 'var(--fg-muted)' }}>{t('tabs.noTabs')}</div>
        <div style={{ marginTop: 4 }}>{t('tabs.noTabsHint')}</div>
      </div>
      <div className="row">
        {harnesses.includes('claude') && (
          <button className="btn btn--sm" onClick={() => void newTab('claude')}>
            <Sparkles size={13} /> {t('tabs.claude')}
          </button>
        )}
        {harnesses.includes('codex') && (
          <button className="btn btn--sm" onClick={() => void newTab('codex')}>
            <Bot size={13} /> {t('tabs.codex')}
          </button>
        )}
        {harnesses.includes('opencode') && (
          <button className="btn btn--sm" onClick={() => void newTab('opencode')}>
            <SquareCode size={13} /> {t('tabs.opencode')}
          </button>
        )}
        <button className="btn btn--sm" onClick={() => void newTab('shell')}>
          <Terminal size={13} /> {t('tabs.shell')}
        </button>
        <button className="btn btn--sm" onClick={openBrowser}>
          <Globe size={13} /> {t('tabs.browser')}
        </button>
      </div>
    </div>
  )
}
