import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { locale as osLocale, platform as osPlatform } from '@tauri-apps/plugin-os'
import { PanelLeft, PanelRight } from 'lucide-react'

import { applyMenu, onPtyActivity, signalReady } from './lib/ipc'
import { findLeaf } from './lib/layout'
import { isTerminalTab } from './lib/types'
import { loadSettings, startSettingsPersistence, useSettings } from './store/settings'
import { loadWorkspace, startWorkspacePersistence, useWorkspace } from './store/workspace'
import { useUi } from './store/ui'
import { menuLabels, resolveLocale, useI18n, useT } from './i18n'
import { readableAccent } from './lib/color'
import { useApplyTheme } from './hooks/useTheme'
import { useMenuActions } from './hooks/useMenuActions'
import { useFileDrop } from './hooks/useFileDrop'
import { useAutoFetch } from './hooks/useAutoFetch'
import { ProjectIcon, Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { RightPanel } from './components/RightPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { UpdateWatcher } from './components/Updater'
import { ExitGuard } from './components/ExitGuard'
import { DragPreview } from './components/DragPreview'
import './styles/global.css'
import './styles/app.css'

export default function App() {
  const t = useT()
  const isDark = useApplyTheme()
  useMenuActions()
  useFileDrop()

  const [booted, setBooted] = useState(false)
  const [platform, setPlatform] = useState<string>('')

  const settings = useSettings((s) => s.settings)
  const setLocale = useI18n((s) => s.setLocale)
  const locale = useI18n((s) => s.locale)

  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const workspaces = useWorkspace((s) => s.workspaces)
  const sidebarOpen = useWorkspace((s) => s.sidebarOpen)
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspace((s) => s.setSidebarWidth)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)
  const setPanel = useWorkspace((s) => s.setPanel)
  const tabs = useWorkspace((s) => s.tabs)

  const settingsOpen = useUi((s) => s.settingsOpen)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)

  // ------------------------------------------------------------- startup --
  useEffect(() => {
    void (async () => {
      const [loaded] = await Promise.all([loadSettings(), loadWorkspace()])
      // Projects always come back; tabs only if the user wants them to.
      if (!loaded.startup.restoreTabs) useWorkspace.getState().discardRestoredTabs()
      const sys = await osLocale().catch(() => null)
      setLocale(resolveLocale(loaded.language, sys))
      setPlatform(osPlatform())
      startSettingsPersistence()
      startWorkspacePersistence()
      setBooted(true)
      // Reveal the window now that the theme and layout are known. This must
      // not go through requestAnimationFrame: a hidden webview never runs one.
      void signalReady().catch(() => {})
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One subscription for every session: the backend emits only transitions,
  // so this stays quiet while nothing is happening.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onPtyActivity(({ id, busy }) => useUi.getState().setTabBusy(id, busy)).then(
      (un) => (unlisten = un),
    )
    return () => unlisten?.()
  }, [])

  // Keep the language reactive to the setting and to the OS preference.
  useEffect(() => {
    if (!booted) return
    void osLocale()
      .catch(() => null)
      .then((sys) => setLocale(resolveLocale(settings.language, sys)))
  }, [booted, settings.language, setLocale])

  // Rebuild the native menu whenever the language changes.
  useEffect(() => {
    if (!booted) return
    void applyMenu(menuLabels()).catch(() => {})
  }, [booted, locale])

  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  )
  const ws = activeProjectId ? workspaces[activeProjectId] : undefined

  // A project's tabs stay mounted once it has been opened, hidden while
  // another project is in front. Mounting them afresh meant new terminals
  // replaying their programs' raw output at a single width, which garbles
  // everything an agent drew at any other.
  const [openedProjects, setOpenedProjects] = useState<string[]>([])
  useEffect(() => {
    if (activeProjectId && !openedProjects.includes(activeProjectId)) {
      setOpenedProjects((ids) => [...ids, activeProjectId])
    }
  }, [activeProjectId, openedProjects])

  // Tabs can be opened anywhere, so the panel has two candidate folders: the
  // project's, and whatever the active tab is working in.
  const tabRoot = useMemo(() => {
    if (!ws) return null
    const group = ws.groups.find((g) => g.id === ws.activeGroupId)
    const pane = group ? findLeaf(group.layout, group.activePaneId) : null
    const active = pane ? tabs[pane.tabId] : undefined
    if (!active) return null
    if (isTerminalTab(active)) return active.cwd
    if (active.kind === 'diff' || active.kind === 'file' || active.kind === 'graph') return active.root
    return null
  }, [tabs, ws])

  const inspectRoot = useMemo(() => {
    if (!project || !ws) return ''
    if (ws.panel.pinnedRoot) return ws.panel.pinnedRoot
    return tabRoot ?? project.root
  }, [project, tabRoot, ws])

  useAutoFetch(inspectRoot, settings.panel.autoFetchMinutes)

  const sidebarRef = useRef<HTMLDivElement>(null)
  // The active project's colour drives the tab and activity chrome. It is a
  // separate token from --accent so choosing a project colour restyles that
  // project's workspace without repainting every button in Settings.
  useEffect(() => {
    const root = document.documentElement
    if (project?.color) {
      root.style.setProperty('--project-accent', readableAccent(project.color, isDark))
    } else {
      root.style.removeProperty('--project-accent')
    }
  }, [project?.color, isDark])

  const startSidebarDrag = useSidebarResize(sidebarRef, setSidebarWidth)

  if (!booted) return <div className="boot" />

  const macOverlay = platform === 'macos'

  return (
    <div
      className={`app${macOverlay ? ' app--overlay' : ''}${
        sidebarOpen ? '' : ' app--nosidebar'
      }`}
    >
      {sidebarOpen && (
        <>
          <div ref={sidebarRef} className="app__sidebar" style={{ width: sidebarWidth }}>
            <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
          </div>
          <div className="app__resizer" onPointerDown={startSidebarDrag} role="separator" />
        </>
      )}

      <main className="app__main">
        <header className="topbar" data-tauri-drag-region>
          <button
            className="icon-btn" aria-label={t('menu.toggleSidebar')}
            title={`${t('menu.toggleSidebar')} (⌘B)`}
            aria-pressed={sidebarOpen} onClick={toggleSidebar}
          >
            <PanelLeft size={15} />
          </button>
          <div className="topbar__title truncate" data-tauri-drag-region>
            {project ? (
              <>
                <ProjectIcon project={project} size={18} />
                <span className="truncate">{project.name}</span>
                <span className="topbar__path truncate subtle">{project.root}</span>
              </>
            ) : (
              <span className="subtle">{t('app.name')}</span>
            )}
          </div>
          <button
            className="icon-btn" aria-label={t('menu.togglePanel')}
            title={`${t('menu.togglePanel')} (⌘⌥B)`}
            aria-pressed={!!ws?.panel.open}
            disabled={!project}
            onClick={() => project && setPanel(project.id, { open: !ws?.panel.open })}
          >
            <PanelRight size={15} />
          </button>
        </header>

        <div className="app__work">
          <div className="app__tiles">
            {openedProjects
              .filter((id) => workspaces[id] && projects.some((p) => p.id === id))
              .map((id) => (
                <Workspace key={id} projectId={id} active={!!ws && id === project?.id} />
              ))}
            {!(project && ws) && (
              <div className="empty">
                <div style={{ fontWeight: 600 }}>{t('sidebar.noProjects')}</div>
                <div className="subtle">{t('sidebar.noProjectsHint')}</div>
              </div>
            )}
          </div>

          {project && ws?.panel.open && (
            <PanelHost
              projectId={project.id}
              root={inspectRoot}
              projectRoot={project.root}
              tabRoot={tabRoot}
            />
          )}
        </div>
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <UpdateWatcher />
      <ExitGuard />
      <DragPreview />
    </div>
  )
}

/** Wraps RightPanel with its own resizer and store bindings. */
function PanelHost({
  projectId, root, projectRoot, tabRoot,
}: { projectId: string; root: string; projectRoot: string; tabRoot: string | null }) {
  const ws = useWorkspace((s) => s.workspaces[projectId])
  const setPanel = useWorkspace((s) => s.setPanel)
  const panel = ws?.panel
  const hostRef = useRef<HTMLDivElement>(null)

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = panel?.width ?? 380
      const el = hostRef.current
      const move = (ev: PointerEvent) => {
        const w = Math.max(260, Math.min(720, startWidth - (ev.clientX - startX)))
        if (el) el.style.width = `${w}px`
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const w = Math.max(260, Math.min(720, startWidth - (ev.clientX - startX)))
        setPanel(projectId, { width: w })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panel?.width, projectId, setPanel],
  )

  if (!panel) return null

  return (
    <>
      <div className="app__resizer" onPointerDown={startDrag} role="separator" />
      <div ref={hostRef} className="app__panel" style={{ width: panel.width }}>
        <RightPanel
          projectId={projectId}
          root={root}
          projectRoot={projectRoot}
          tabRoot={tabRoot}
          view={panel.view}
          pinnedRoot={panel.pinnedRoot}
          onViewChange={(view) => setPanel(projectId, { view })}
          onClose={() => setPanel(projectId, { open: false })}
          onScopeChange={(scope) =>
            setPanel(projectId, { pinnedRoot: scope === 'project' ? projectRoot : null })
          }
          onPickRoot={(path) => setPanel(projectId, { pinnedRoot: path })}
        />
      </div>
    </>
  )
}

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420

function useSidebarResize(
  ref: React.RefObject<HTMLDivElement | null>,
  setWidth: (w: number) => void,
) {
  return useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const clamp = (x: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, x))
      const move = (ev: PointerEvent) => {
        if (ref.current) ref.current.style.width = `${clamp(ev.clientX)}px`
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setWidth(clamp(ev.clientX))
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [ref, setWidth],
  )
}
