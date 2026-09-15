import { create } from 'zustand'
import { deepMerge } from '../lib/merge'
import { DEFAULT_UI_THEME } from '../lib/uiThemes'
import { stateLoad, stateSave } from '../lib/ipc'
import type { HarnessKind, Settings } from '../lib/types'

const STATE_KEY = 'settings'

export const SETTINGS_VERSION = 3

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
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
    // Off, as in Terminal.app: on most non-US layouts Option types
    // characters that have no other key.
    optionIsMeta: false,
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
    opencode: {
      command: 'opencode',
      args: [],
      resumeArgs: ['--continue'],
      // OpenCode has no system-prompt flag — `--prompt` would send the
      // instructions as the first message — so it gets them from
      // .almastudio/instructions.md and the environment.
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
    // Off, as VS Code's git.autofetch is out of the box.
    autoFetchMinutes: 0,
  },
  startup: {
    restoreTabs: true,
    restoreScrollback: true,
    autoStartTabs: true,
    confirmOnExit: true,
  },
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

/**
 * Brings an older settings file forward. Runs before the merge, on the raw
 * parsed object, so it can look at values the current shape no longer has.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const from = typeof raw.version === 'number' ? raw.version : 1

  if (from < 2) {
    // `accent` used to be a required colour that defaulted to the Almaware
    // green. It is now an override, where empty means "use the theme's own
    // accent" — so a stored value equal to that old default was never a
    // deliberate choice and should not survive as one.
    if (raw.accent === '#7cb518') raw.accent = ''
  }

  if (from < 3) {
    // Auto-start shipped defaulting to off, which meant every tab waited
    // behind a Start button. The default is now on; carry existing files over
    // rather than leaving them on a default nobody chose.
    const startup = raw.startup as Record<string, unknown> | undefined
    if (startup && startup.autoStartTabs === false) startup.autoStartTabs = true
  }

  raw.version = SETTINGS_VERSION
  return raw
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await stateLoad(STATE_KEY)
    if (!raw) {
      useSettings.getState().hydrate(DEFAULT_SETTINGS)
      return DEFAULT_SETTINGS
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const wasOlder = parsed.version !== SETTINGS_VERSION
    const merged = deepMerge(DEFAULT_SETTINGS, migrate(parsed))
    useSettings.getState().hydrate(merged)
    // Persist straight away when a migration actually changed something, so
    // the file on disk stops being an older shape than the app expects.
    if (wasOlder) void stateSave(STATE_KEY, JSON.stringify(merged)).catch(() => {})
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
