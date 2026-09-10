import { create } from 'zustand'

export type SettingsSection = 'appearance' | 'terminal' | 'harness' | 'workspace' | 'updates' | 'about'

/** Transient UI state — never persisted. */
interface UiState {
  settingsOpen: boolean
  /** The Settings page shown; kept here so a menu item can open a given one. */
  settingsSection: SettingsSection
  newProjectOpen: boolean
  /**
   * Which sessions are currently producing output. Derived from pty activity
   * events and deliberately not persisted — it describes right now, and the
   * backend re-derives it as soon as a session starts.
   */
  busyTabs: Record<string, boolean>
  /** Tabs with unsaved edits, so the tab strip can mark them. */
  dirtyTabs: Record<string, boolean>
  /**
   * How many modals or menus are currently open. A browser tab is a native
   * child webview that floats above the HTML layer, so it has to be hidden
   * while anything is supposed to appear on top of it.
   */
  overlays: number
  /** Current webview zoom; positions reported by native events are unzoomed. */
  zoom: number
  /** Opening starts on `section`, or on Appearance when none is given. */
  setSettingsOpen: (v: boolean, section?: SettingsSection) => void
  setSettingsSection: (section: SettingsSection) => void
  setNewProjectOpen: (v: boolean) => void
  setTabBusy: (id: string, busy: boolean) => void
  clearTabBusy: (id: string) => void
  setTabDirty: (id: string, dirty: boolean) => void
  pushOverlay: () => void
  popOverlay: () => void
  setZoom: (zoom: number) => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsSection: 'appearance',
  newProjectOpen: false,
  busyTabs: {},
  dirtyTabs: {},
  overlays: 0,
  zoom: 1,
  setZoom: (zoom) => set({ zoom }),
  setSettingsOpen: (v, section) =>
    set(v ? { settingsOpen: true, settingsSection: section ?? 'appearance' } : { settingsOpen: false }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  setNewProjectOpen: (v) => set({ newProjectOpen: v }),
  setTabBusy: (id, busy) =>
    set((s) => (s.busyTabs[id] === busy ? s : { busyTabs: { ...s.busyTabs, [id]: busy } })),
  clearTabBusy: (id) =>
    set((s) => {
      if (!(id in s.busyTabs)) return s
      const next = { ...s.busyTabs }
      delete next[id]
      return { busyTabs: next }
    }),
  pushOverlay: () => set((s) => ({ overlays: s.overlays + 1 })),
  popOverlay: () => set((s) => ({ overlays: Math.max(0, s.overlays - 1) })),
  setTabDirty: (id, dirty) =>
    set((s) => {
      if (!!s.dirtyTabs[id] === dirty) return s
      const next = { ...s.dirtyTabs }
      if (dirty) next[id] = true
      else delete next[id]
      return { dirtyTabs: next }
    }),
}))
