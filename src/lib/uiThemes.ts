/** UI theme registry.
 *
 * A theme is just a map of CSS custom properties applied to :root at runtime,
 * so adding one is a data change — no CSS to touch. Each theme supplies a dark
 * and a light variant plus the terminal colour scheme that goes with it; the
 * app's dark/light *mode* then picks the variant.
 *
 * The defaults follow VS Code's Dark+ / Light+ so the app reads as familiar
 * next to an editor rather than inventing its own greys. */

export const TOKENS = [
  'bg', 'bg-raised', 'bg-panel', 'bg-inset', 'bg-hover', 'bg-active', 'bg-selected',
  'fg', 'fg-muted', 'fg-subtle', 'fg-inverted',
  'border', 'border-strong',
  'accent', 'accent-strong', 'accent-fg',
  'green', 'red', 'yellow', 'blue', 'purple',
  'diff-add-bg', 'diff-add-gutter', 'diff-add-word',
  'diff-del-bg', 'diff-del-gutter', 'diff-del-word',
  'term-bg', 'term-fg',
  'shadow-1', 'shadow-2',
] as const

export type TokenName = (typeof TOKENS)[number]
export type ThemeTokens = Record<TokenName, string>

export interface UiTheme {
  id: string
  name: string
  dark: ThemeTokens
  light: ThemeTokens
  /** Terminal scheme used when the terminal is set to follow the UI theme. */
  terminal: { dark: string; light: string }
}

// --------------------------------------------------------------- VS Code ---

const vscodeDark: ThemeTokens = {
  bg: '#1e1e1e',
  'bg-raised': '#252526',
  'bg-panel': '#252526',
  'bg-inset': '#3c3c3c',
  'bg-hover': '#2a2d2e',
  'bg-active': '#37373d',
  'bg-selected': '#04395e',

  fg: '#cccccc',
  'fg-muted': '#9d9d9d',
  'fg-subtle': '#7f7f7f',
  'fg-inverted': '#ffffff',

  border: '#2b2b2b',
  'border-strong': '#454545',

  accent: '#0078d4',
  'accent-strong': '#3794ff',
  'accent-fg': '#ffffff',

  green: '#73c991',
  red: '#f14c4c',
  yellow: '#e2c08d',
  blue: '#3794ff',
  purple: '#c586c0',

  // gitDecoration / diffEditor colours from Dark+.
  'diff-add-bg': 'rgba(155, 185, 85, 0.16)',
  'diff-add-gutter': 'rgba(155, 185, 85, 0.30)',
  'diff-add-word': 'rgba(155, 185, 85, 0.40)',
  'diff-del-bg': 'rgba(255, 0, 0, 0.16)',
  'diff-del-gutter': 'rgba(255, 0, 0, 0.28)',
  'diff-del-word': 'rgba(255, 0, 0, 0.36)',

  'term-bg': '#1e1e1e',
  'term-fg': '#cccccc',

  'shadow-1': '0 1px 2px rgba(0, 0, 0, 0.36)',
  'shadow-2': '0 8px 28px rgba(0, 0, 0, 0.56)',
}

const vscodeLight: ThemeTokens = {
  bg: '#ffffff',
  'bg-raised': '#ffffff',
  'bg-panel': '#f3f3f3',
  'bg-inset': '#ffffff',
  'bg-hover': '#e8e8e8',
  'bg-active': '#e4e6f1',
  'bg-selected': '#cfe4fa',

  fg: '#3b3b3b',
  'fg-muted': '#616161',
  'fg-subtle': '#8b8b8b',
  'fg-inverted': '#ffffff',

  border: '#e5e5e5',
  'border-strong': '#cecece',

  accent: '#005fb8',
  'accent-strong': '#0258a8',
  'accent-fg': '#ffffff',

  green: '#388a34',
  red: '#ad0707',
  yellow: '#895503',
  blue: '#005fb8',
  purple: '#af00db',

  'diff-add-bg': 'rgba(155, 185, 85, 0.20)',
  'diff-add-gutter': 'rgba(103, 145, 40, 0.34)',
  'diff-add-word': 'rgba(103, 145, 40, 0.40)',
  'diff-del-bg': 'rgba(255, 0, 0, 0.12)',
  'diff-del-gutter': 'rgba(197, 30, 30, 0.28)',
  'diff-del-word': 'rgba(197, 30, 30, 0.32)',

  'term-bg': '#ffffff',
  'term-fg': '#3b3b3b',

  'shadow-1': '0 1px 2px rgba(0, 0, 0, 0.10)',
  'shadow-2': '0 8px 28px rgba(0, 0, 0, 0.16)',
}

// -------------------------------------------------------------- Almaware ---

const almawareDark: ThemeTokens = {
  ...vscodeDark,
  bg: '#0e110c',
  'bg-raised': '#14180f',
  'bg-panel': '#12160e',
  'bg-inset': '#0a0c08',
  'bg-hover': '#1c2216',
  'bg-active': '#232b1b',
  'bg-selected': '#2c3a19',
  fg: '#e6e9e0',
  'fg-muted': '#9aa392',
  'fg-subtle': '#6b7364',
  border: '#232a1d',
  'border-strong': '#313a28',
  accent: '#7cb518',
  'accent-strong': '#99d420',
  'accent-fg': '#0b0f06',
  green: '#8fce30',
  red: '#e5605f',
  yellow: '#d9b23c',
  blue: '#62a8de',
  purple: '#b18ce0',
  'term-bg': '#0a0c08',
  'term-fg': '#d8ddd0',
}

const almawareLight: ThemeTokens = {
  ...vscodeLight,
  bg: '#ffffff',
  'bg-panel': '#f4f5ef',
  'bg-hover': '#e9ebe1',
  'bg-active': '#dfe2d5',
  'bg-selected': '#e2eec6',
  fg: '#1c2118',
  'fg-muted': '#5d6553',
  'fg-subtle': '#868e7c',
  border: '#dcded3',
  'border-strong': '#c5c9ba',
  accent: '#5d8f10',
  'accent-strong': '#4c7a0c',
  'accent-fg': '#ffffff',
  green: '#4b8b16',
  yellow: '#a9781a',
  'term-bg': '#fdfdfa',
  'term-fg': '#24291f',
}

// ---------------------------------------------------------------- registry --

export const UI_THEMES: UiTheme[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    dark: vscodeDark,
    light: vscodeLight,
    terminal: { dark: 'vscode-dark', light: 'vscode-light' },
  },
  {
    id: 'almaware',
    name: 'Almaware',
    dark: almawareDark,
    light: almawareLight,
    terminal: { dark: 'almaware-dark', light: 'almaware-light' },
  },
]

export const DEFAULT_UI_THEME = 'vscode'

export function resolveUiTheme(id: string): UiTheme {
  return UI_THEMES.find((t) => t.id === id) ?? UI_THEMES[0]
}

/** Writes a theme's variant onto an element as CSS custom properties. */
export function applyTokens(el: HTMLElement, theme: UiTheme, dark: boolean) {
  const tokens = dark ? theme.dark : theme.light
  for (const name of TOKENS) {
    el.style.setProperty(`--${name}`, tokens[name])
  }
}
