import { useCallback, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  ArrowDown, ArrowUp, FolderOpen, ImageUp, Loader2, Pencil, Plus, Search,
  Settings2, Trash2, X,
} from 'lucide-react'

import { dirName, writeProjectInstructions } from '../lib/ipc'
import { readableAccent } from '../lib/color'
import { pickProjectIcon } from '../lib/image'
import { useWorkspace } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useTheme } from '../hooks/useTheme'
import { useT } from '../i18n'
import { ConfirmDialog, Field, MenuItem, MenuSeparator, Modal, Popover } from './ui'
import { isTerminalTab, type HarnessKind, type Project } from '../lib/types'

const ICONS = [
  '🟢', '🚀', '⚙️', '📦', '🧪', '🔧', '🌐', '📱', '🖥️', '🗄️',
  '🧩', '📊', '🔐', '🎛️', '🛰️', '🏗️', '💡', '🧠', '📚', '🎨',
]
/** Distinct from the tab MIME so a tab can never be dropped into the list. */
const PROJECT_MIME = 'application/x-almastudio-project'

const COLORS = [
  '#7cb518', '#4a9ede', '#e0973c', '#d1594f', '#9b6bdb',
  '#2fae91', '#d4b03c', '#7a8290',
]

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT()
  const isDark = useTheme()
  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const setActiveProject = useWorkspace((s) => s.setActiveProject)
  const removeProject = useWorkspace((s) => s.removeProject)
  const [query, setQuery] = useState('')
  const reorderProjects = useWorkspace((s) => s.reorderProjects)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<Project | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; project: Project } | null>(null)
  // Position in the real order, which is what the move actions operate on.
  const menuIndex = menu ? projects.findIndex((p) => p.id === menu.project.id) : -1

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q),
    )
  }, [projects, query])

  // Reordering a filtered list would move rows the user cannot see, so it is
  // only offered when the whole list is on screen.
  const canReorder = !query.trim() && projects.length > 1

  const endDrag = () => {
    setDragIndex(null)
    setDropIndex(null)
  }

  const commitDrop = (to: number) => {
    if (dragIndex !== null) reorderProjects(dragIndex, to)
    endDrag()
  }

  return (
    <nav className="sidebar">
      <div className="sidebar__head" data-tauri-drag-region>
        <span className="sidebar__title">{t('sidebar.projects')}</span>
        <button
          className="icon-btn" aria-label={t('sidebar.newProject')}
          onClick={() => setEditing('new')}
        >
          <Plus size={15} />
        </button>
      </div>

      {projects.length > 4 && (
        <div className="sidebar__search">
          <Search size={12} className="subtle" />
          <input
            className="sidebar__search-input" placeholder={t('sidebar.search')}
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div
        className="sidebar__list"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PROJECT_MIME)) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(PROJECT_MIME)) return
          e.preventDefault()
          // Dropping in the empty space below the rows means "put it last".
          commitDrop(projects.length)
        }}
      >
        {projects.length === 0 && (
          <div className="empty">
            <div style={{ fontWeight: 600 }}>{t('sidebar.noProjects')}</div>
            <div className="subtle">{t('sidebar.noProjectsHint')}</div>
            <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>
              <Plus size={13} /> {t('sidebar.addProject')}
            </button>
          </div>
        )}
        {filtered.map((p, index) => (
          <button
            key={p.id}
            className={[
              'project',
              p.id === activeProjectId ? 'project--active' : '',
              dropIndex === index ? 'project--drop-before' : '',
              dropIndex === index + 1 ? 'project--drop-after' : '',
              dragIndex === index ? 'project--dragging' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={
              { '--project-row-accent': readableAccent(p.color, isDark) } as React.CSSProperties
            }
            draggable={canReorder}
            onDragStart={(e) => {
              e.dataTransfer.setData(PROJECT_MIME, p.id)
              e.dataTransfer.effectAllowed = 'move'
              setDragIndex(index)
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PROJECT_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const r = e.currentTarget.getBoundingClientRect()
              const next = e.clientY < r.top + r.height / 2 ? index : index + 1
              if (next !== dropIndex) setDropIndex(next)
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(PROJECT_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              commitDrop(e.clientY < r.top + r.height / 2 ? index : index + 1)
            }}
            onClick={() => setActiveProject(p.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ anchor: e.currentTarget, project: p })
            }}
            title={p.root}
          >
            <ProjectIcon project={p} />
            <span className="project__text">
              <span className="project__name truncate">{p.name}</span>
              <span className="project__path truncate subtle">{p.root}</span>
            </span>
            <ProjectActivity projectId={p.id} color={readableAccent(p.color, isDark)} />
          </button>
        ))}
      </div>

      <div className="sidebar__foot">
        <button className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
          <Settings2 size={14} /> {t('settings.title')}
        </button>
      </div>

      <Popover
        anchor={menu?.anchor ?? null} open={!!menu} onClose={() => setMenu(null)}
      >
        {projects.length > 1 && (
          <>
            <MenuItem
              icon={<ArrowUp size={13} />} label={t('sidebar.moveUp')}
              disabled={menuIndex <= 0}
              onClick={() => { setMenu(null); reorderProjects(menuIndex, menuIndex - 1) }}
            />
            <MenuItem
              icon={<ArrowDown size={13} />} label={t('sidebar.moveDown')}
              disabled={menuIndex < 0 || menuIndex >= projects.length - 1}
              onClick={() => { setMenu(null); reorderProjects(menuIndex, menuIndex + 2) }}
            />
            <MenuSeparator />
          </>
        )}
        <MenuItem
          icon={<Pencil size={13} />} label={t('sidebar.edit')}
          onClick={() => { const p = menu!.project; setMenu(null); setEditing(p) }}
        />
        <MenuItem
          icon={<FolderOpen size={13} />} label={t('sidebar.openInFinder')}
          onClick={() => {
            const p = menu!.project
            setMenu(null)
            void revealItemInDir(p.root).catch(() => {})
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 size={13} />} label={t('sidebar.remove')} danger
          onClick={() => { const p = menu!.project; setMenu(null); setConfirmRemove(p) }}
        />
      </Popover>

      {editing && (
        <ProjectDialog
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={t('sidebar.remove')}
          message={t('sidebar.removeConfirm', { name: confirmRemove.name })}
          confirmLabel={t('common.remove')} danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => { removeProject(confirmRemove.id); setConfirmRemove(null) }}
        />
      )}
    </nav>
  )
}

export function ProjectIcon({ project, size = 24 }: { project: Project; size?: number }) {
  if (project.iconImage) {
    return (
      <img
        className="project__icon project__icon--image"
        src={project.iconImage}
        alt=""
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="project__icon"
      style={{
        background: `${project.color}22`,
        color: project.color,
        width: size,
        height: size,
      }}
    >
      {project.icon || '•'}
    </span>
  )
}

/**
 * Shows whether any harness in this project is loaded, and whether one is
 * currently working. Status comes from the store rather than from a mounted
 * terminal, so a project you are not looking at still reports accurately.
 */
function ProjectActivity({ projectId, color }: { projectId: string; color: string }) {
  const t = useT()
  const tabs = useWorkspace((s) => s.tabs)
  const busyTabs = useUi((s) => s.busyTabs)

  const { loaded, busy } = useMemo(() => {
    let loaded = false
    let busy = false
    for (const tab of Object.values(tabs)) {
      if (tab.projectId !== projectId || !isTerminalTab(tab)) continue
      if (tab.status === 'running' || tab.status === 'starting') {
        loaded = true
        if (busyTabs[tab.id]) busy = true
      }
    }
    return { loaded, busy }
  }, [tabs, busyTabs, projectId])

  if (!loaded) return null
  return busy ? (
    <Loader2 size={12} className="project__spinner" style={{ color }} aria-label={t('tabs.working')} />
  ) : (
    <span className="project__dot" style={{ color }} title={t('tabs.waiting')} aria-hidden />
  )
}

// -------------------------------------------------------- project dialog ---

function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const t = useT()
  const addProject = useWorkspace((s) => s.addProject)
  const updateProject = useWorkspace((s) => s.updateProject)
  const defaultHarness = useSettings((s) => s.settings.defaultHarness)

  const [name, setName] = useState(project?.name ?? '')
  const [root, setRoot] = useState(project?.root ?? '')
  const [icon, setIcon] = useState(project?.icon ?? ICONS[0])
  const [iconImage, setIconImage] = useState(project?.iconImage)
  const [color, setColor] = useState(project?.color ?? COLORS[0])
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [harness, setHarness] = useState<HarnessKind | 'default'>(
    project?.defaultHarness ?? 'default',
  )
  const [error, setError] = useState<string | null>(null)

  const pickFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, defaultPath: root || undefined })
    if (typeof picked !== 'string') return
    setRoot(picked)
    if (!name.trim()) setName(await dirName(picked).catch(() => ''))
  }, [name, root])

  const chooseImage = useCallback(async () => {
    try {
      const dataUrl = await pickProjectIcon()
      if (dataUrl) setIconImage(dataUrl)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const save = useCallback(() => {
    if (!root.trim()) return setError(t('project.folderRequired'))
    if (!name.trim()) return setError(t('project.nameRequired'))

    const payload = {
      name: name.trim(), root: root.trim(), icon, color,
      // Undefined rather than '' so the merge on load treats it as absent.
      iconImage: iconImage || undefined,
      instructions, defaultHarness: harness,
    }
    if (project) updateProject(project.id, payload)
    else addProject(payload)

    // Mirror the instructions into the project so any tool can read them.
    if (instructions.trim()) {
      void writeProjectInstructions(root.trim(), instructions).catch(() => {})
    }
    onClose()
  }, [addProject, color, harness, icon, iconImage, instructions, name, onClose, project, root, t, updateProject])

  return (
    <Modal
      title={project ? t('project.edit') : t('project.new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('project.cancel')}</button>
          <button className="btn btn--primary" onClick={save}>
            {project ? t('project.save') : t('project.create')}
          </button>
        </>
      }
    >
      {error && <div className="alert">{error}</div>}

      <Field label={t('project.folder')} hint={t('project.folderHint')}>
        <div className="row">
          <input
            className="input mono" value={root} placeholder="/Users/you/code/project"
            onChange={(e) => setRoot(e.target.value)}
          />
          <button className="btn" onClick={() => void pickFolder()}>{t('project.choose')}</button>
        </div>
      </Field>

      <Field label={t('project.name')}>
        <input
          className="input" value={name} placeholder={t('project.namePlaceholder')}
          onChange={(e) => setName(e.target.value)} autoFocus
        />
      </Field>

      <Field label={t('project.icon')} hint={t('project.iconHint')}>
        <div className="row" style={{ marginBottom: 8 }}>
          {iconImage ? (
            <>
              <img className="project__icon project__icon--image" src={iconImage} alt="" />
              <button className="btn btn--sm" onClick={() => void chooseImage()}>
                <ImageUp size={13} /> {t('project.changeImage')}
              </button>
              <button className="btn btn--sm" onClick={() => setIconImage(undefined)}>
                <X size={13} /> {t('project.removeImage')}
              </button>
            </>
          ) : (
            <button className="btn btn--sm" onClick={() => void chooseImage()}>
              <ImageUp size={13} /> {t('project.chooseImage')}
            </button>
          )}
        </div>
        {!iconImage && (
          <div className="iconpick">
            {ICONS.map((i) => (
              <button
                key={i} className={`iconpick__item${i === icon ? ' iconpick__item--on' : ''}`}
                onClick={() => setIcon(i)}
              >
                {i}
              </button>
            ))}
          </div>
        )}
      </Field>

      <Field label={t('project.color')} hint={t('project.colorHint')}>
        <div className="row">
          {COLORS.map((c) => (
            <button
              key={c} className={`swatch${c === color ? ' swatch--on' : ''}`}
              style={{ background: c }} onClick={() => setColor(c)} aria-label={c}
            />
          ))}
          <input
            className="swatch swatch--input" type="color" value={color}
            onChange={(e) => setColor(e.target.value)} aria-label={t('project.color')}
          />
        </div>
      </Field>

      <Field label={t('project.defaultHarness')}>
        <select
          className="select" value={harness}
          onChange={(e) => setHarness(e.target.value as HarnessKind | 'default')}
        >
          <option value="default">
            {t('project.useGlobal')} ({t(`tabs.${defaultHarness}`)})
          </option>
          <option value="claude">{t('tabs.claude')}</option>
          <option value="codex">{t('tabs.codex')}</option>
          <option value="shell">{t('tabs.shell')}</option>
        </select>
      </Field>

      <Field label={t('project.instructions')} hint={t('project.instructionsHint')}>
        <textarea
          className="textarea" rows={7} value={instructions}
          placeholder={t('project.instructionsPlaceholder')}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>
    </Modal>
  )
}
