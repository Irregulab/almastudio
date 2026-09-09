import { create } from 'zustand'

/** Transient UI state — never persisted. */
interface UiState {
  settingsOpen: boolean
  newProjectOpen: boolean
  setSettingsOpen: (v: boolean) => void
  setNewProjectOpen: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  newProjectOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setNewProjectOpen: (v) => set({ newProjectOpen: v }),
}))
