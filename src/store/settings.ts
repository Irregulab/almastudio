import { create } from 'zustand'
import { deepMerge } from '../lib/merge'
import { DEFAULT_UI_THEME } from '../lib/uiThemes'
import { stateLoad, stateSave } from '../lib/ipc'
import type { HarnessKind, Settings } from '../lib/types'

const STATE_KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: 'system',
  uiTheme: DEFAULT_UI_THEME,
  accent: '',
  language: 'system',
  ui: { fontFamily: '', fontSize: 13, density: 'comfortable' },
  terminal: {
    fontFamily: '',
    fontSize: 13,
    lineHeight: 1.25,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    copyOnSelect: false,
    rightClickPaste: true,
    scheme: 'auto',
    shell: '',
    loginShell: true,
  },
  defaultHarness: 'claude',
  harness: {
    claude: {
      command: 'claude',
      args: [],
      // `--continue` picks the previous conversation back up, which is what
      // "restore my tabs" should mean for an agent rather than a blank session.
      resumeArgs: ['--continue'],
      instructionsMode: 'flag',
      instructionsFlag: '--append-system-prompt',
    },
    codex: {
      command: 'codex',
      args: [],
      resumeArgs: ['resume', '--last'],
      instructionsMode: 'env',
      instructionsFlag: '',
    },
    shell: {
      command: '',
      args: [],
      resumeArgs: [],
      instructionsMode: 'env',
      instructionsFlag: '',
    },
  },
  panel: {
    defaultView: 'changes',
    showHidden: false,
    respectGitignore: true,
    watch: true,
    diffView: 'unified',
    contextLines: 3,
  },
  startup: { restoreTabs: true, restoreScrollback: true, autoStartTabs: false },
  updates: { autoCheck: true, intervalHours: 6 },
}

interface SettingsStore {
  settings: Settings
  loaded: boolean
  set: (patch: Partial<Settings>) => void
  patch: <K extends keyof Settings>(key: K, value: Partial<Settings[K]>) => void
  setHarness: (kind: HarnessKind, value: Partial<Settings['harness'][HarnessKind]>) => void
  reset: () => void
  hydrate: (s: Settings) => void
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  set: (patch) => set({ settings: { ...get().settings, ...patch } }),
  patch: (key, value) =>
    set({
      settings: {
        ...get().settings,
        [key]: { ...(get().settings[key] as object), ...(value as object) },
      },
    }),
  setHarness: (kind, value) =>
    set({
      settings: {
        ...get().settings,
        harness: {
          ...get().settings.harness,
          [kind]: { ...get().settings.harness[kind], ...value },
        },
      },
    }),
  reset: () => set({ settings: DEFAULT_SETTINGS }),
  hydrate: (s) => set({ settings: s, loaded: true }),
}))

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await stateLoad(STATE_KEY)
    const merged = raw
      ? deepMerge(DEFAULT_SETTINGS, JSON.parse(raw) as unknown)
      : DEFAULT_SETTINGS
    useSettings.getState().hydrate(merged)
    return merged
  } catch {
    // A corrupt or unreadable settings file must never block startup.
    useSettings.getState().hydrate(DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS
  }
}

let saveTimer: number | undefined

/** Debounced persistence; settings change on every keystroke in the panel. */
export function startSettingsPersistence() {
  useSettings.subscribe((state, prev) => {
    if (!state.loaded || state.settings === prev.settings) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void stateSave(STATE_KEY, JSON.stringify(state.settings)).catch(() => {})
    }, 300)
  })
}
