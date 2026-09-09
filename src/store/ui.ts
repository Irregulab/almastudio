import { create } from 'zustand'

/** Transient UI state — never persisted. */
interface UiState {
  settingsOpen: boolean
  newProjectOpen: boolean
  /**
   * Which sessions are currently producing output. Derived from pty activity
   * events and deliberately not persisted — it describes right now, and the
   * backend re-derives it as soon as a session starts.
   */
  busyTabs: Record<string, boolean>
  /** Tabs with unsaved edits, so the tab strip can mark them. */
  dirtyTabs: Record<string, boolean>
  setSettingsOpen: (v: boolean) => void
  setNewProjectOpen: (v: boolean) => void
  setTabBusy: (id: string, busy: boolean) => void
  clearTabBusy: (id: string) => void
  setTabDirty: (id: string, dirty: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  newProjectOpen: false,
  busyTabs: {},
  dirtyTabs: {},
  setSettingsOpen: (v) => set({ settingsOpen: v }),
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
  setTabDirty: (id, dirty) =>
    set((s) => {
      if (!!s.dirtyTabs[id] === dirty) return s
      const next = { ...s.dirtyTabs }
      if (dirty) next[id] = true
      else delete next[id]
      return { dirtyTabs: next }
    }),
}))
