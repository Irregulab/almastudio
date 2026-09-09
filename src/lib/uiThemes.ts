/** UI theme registry.
 *
 * A theme is a map of CSS custom properties applied to :root at runtime, so
 * adding one is a data change — no CSS to touch. Each theme supplies a dark
 * and a light variant plus the terminal colour scheme that goes with it; the
 * app's dark/light *mode* then picks the variant.
 *
 * Variants are written as compact palettes and expanded by `tokens()` below.
 * Spelling out all forty-odd custom properties per variant would be both
 * repetitive and easy to get subtly wrong, and the derived values (diff
 * washes, shadows) would drift apart between themes.
 */

import { parseHex } from './color'

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
  // Syntax colours, so a theme owns highlighting as well as chrome.
  'syn-comment', 'syn-keyword', 'syn-control', 'syn-string', 'syn-number',
  'syn-function', 'syn-type', 'syn-variable', 'syn-constant', 'syn-tag',
  'syn-attr', 'syn-regexp', 'syn-operator', 'syn-meta',
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

// ------------------------------------------------------------- expansion ---

interface Palette {
  dark: boolean
  bg: string; raised: string; panel: string; inset: string
  hover: string; active: string; selected: string
  fg: string; muted: string; subtle: string
  border: string; borderStrong: string
  accent: string; accentStrong: string; accentFg: string
  green: string; red: string; yellow: string; blue: string; purple: string
  termBg?: string; termFg?: string
  /** Diff washes default to the semantic green/red. */
  diffAdd?: string; diffDel?: string
  // syntax
  comment: string; keyword: string; control: string; str: string; number: string
  fn: string; type: string; variable: string; constant: string; tag: string
  attr: string; regexp: string; operator: string; meta: string
}

/** `rgba()` from a hex colour, for the translucent diff washes. */
function alpha(hex: string, a: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

function tokens(p: Palette): ThemeTokens {
  const add = p.diffAdd ?? p.green
  const del = p.diffDel ?? p.red
  // Light backgrounds need a touch more wash to read at the same strength.
  const lift = p.dark ? 0 : 0.04

  return {
    bg: p.bg,
    'bg-raised': p.raised,
    'bg-panel': p.panel,
    'bg-inset': p.inset,
    'bg-hover': p.hover,
    'bg-active': p.active,
    'bg-selected': p.selected,

    fg: p.fg,
    'fg-muted': p.muted,
    'fg-subtle': p.subtle,
    'fg-inverted': p.dark ? '#ffffff' : '#ffffff',

    border: p.border,
    'border-strong': p.borderStrong,

    accent: p.accent,
    'accent-strong': p.accentStrong,
    'accent-fg': p.accentFg,

    green: p.green,
    red: p.red,
    yellow: p.yellow,
    blue: p.blue,
    purple: p.purple,

    'diff-add-bg': alpha(add, 0.16 + lift),
    'diff-add-gutter': alpha(add, 0.3 + lift),
    'diff-add-word': alpha(add, 0.4),
    'diff-del-bg': alpha(del, 0.16 + lift),
    'diff-del-gutter': alpha(del, 0.28 + lift),
    'diff-del-word': alpha(del, 0.36),

    'term-bg': p.termBg ?? p.bg,
    'term-fg': p.termFg ?? p.fg,

    'shadow-1': p.dark
      ? '0 1px 2px rgba(0, 0, 0, 0.36)'
      : '0 1px 2px rgba(0, 0, 0, 0.10)',
    'shadow-2': p.dark
      ? '0 8px 28px rgba(0, 0, 0, 0.56)'
      : '0 8px 28px rgba(0, 0, 0, 0.16)',

    'syn-comment': p.comment,
    'syn-keyword': p.keyword,
    'syn-control': p.control,
    'syn-string': p.str,
    'syn-number': p.number,
    'syn-function': p.fn,
    'syn-type': p.type,
    'syn-variable': p.variable,
    'syn-constant': p.constant,
    'syn-tag': p.tag,
    'syn-attr': p.attr,
    'syn-regexp': p.regexp,
    'syn-operator': p.operator,
    'syn-meta': p.meta,
  }
}

// ---------------------------------------------------------------- VS Code ---

const vscodeDark = tokens({
  dark: true,
  bg: '#1e1e1e', raised: '#252526', panel: '#252526', inset: '#3c3c3c',
  hover: '#2a2d2e', active: '#37373d', selected: '#04395e',
  fg: '#cccccc', muted: '#9d9d9d', subtle: '#7f7f7f',
  border: '#2b2b2b', borderStrong: '#454545',
  accent: '#0078d4', accentStrong: '#3794ff', accentFg: '#ffffff',
  green: '#73c991', red: '#f14c4c', yellow: '#e2c08d', blue: '#3794ff', purple: '#c586c0',
  // VS Code's own diff washes, which are yellower than its git-decoration green.
  diffAdd: '#9bb955', diffDel: '#ff0000',
  comment: '#6a9955', keyword: '#569cd6', control: '#c586c0', str: '#ce9178',
  number: '#b5cea8', fn: '#dcdcaa', type: '#4ec9b0', variable: '#9cdcfe',
  constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe', regexp: '#d16969',
  operator: '#d4d4d4', meta: '#c586c0',
})

const vscodeLight = tokens({
  dark: false,
  bg: '#ffffff', raised: '#ffffff', panel: '#f3f3f3', inset: '#ffffff',
  hover: '#e8e8e8', active: '#e4e6f1', selected: '#cfe4fa',
  fg: '#3b3b3b', muted: '#616161', subtle: '#8b8b8b',
  border: '#e5e5e5', borderStrong: '#cecece',
  accent: '#005fb8', accentStrong: '#0258a8', accentFg: '#ffffff',
  green: '#388a34', red: '#ad0707', yellow: '#895503', blue: '#005fb8', purple: '#af00db',
  diffAdd: '#679128', diffDel: '#c51e1e',
  comment: '#008000', keyword: '#0000ff', control: '#af00db', str: '#a31515',
  number: '#098658', fn: '#795e26', type: '#267f99', variable: '#001080',
  constant: '#0070c1', tag: '#800000', attr: '#e50000', regexp: '#811f3f',
  operator: '#000000', meta: '#af00db',
})

// --------------------------------------------------------------- Almaware ---

const almawareDark = tokens({
  dark: true,
  bg: '#0e110c', raised: '#14180f', panel: '#12160e', inset: '#0a0c08',
  hover: '#1c2216', active: '#232b1b', selected: '#2c3a19',
  fg: '#e6e9e0', muted: '#9aa392', subtle: '#6b7364',
  border: '#232a1d', borderStrong: '#313a28',
  accent: '#7cb518', accentStrong: '#99d420', accentFg: '#0b0f06',
  green: '#8fce30', red: '#e5605f', yellow: '#d9b23c', blue: '#62a8de', purple: '#b18ce0',
  termBg: '#0a0c08', termFg: '#d8ddd0',
  comment: '#6a9955', keyword: '#8fce30', control: '#b18ce0', str: '#d9b23c',
  number: '#c3e88d', fn: '#dcdcaa', type: '#4fb8ad', variable: '#cfd8c4',
  constant: '#99d420', tag: '#8fce30', attr: '#c3e88d', regexp: '#e5605f',
  operator: '#9aa392', meta: '#b18ce0',
})

const almawareLight = tokens({
  dark: false,
  bg: '#ffffff', raised: '#ffffff', panel: '#f4f5ef', inset: '#ffffff',
  hover: '#e9ebe1', active: '#dfe2d5', selected: '#e2eec6',
  fg: '#1c2118', muted: '#5d6553', subtle: '#868e7c',
  border: '#dcded3', borderStrong: '#c5c9ba',
  accent: '#5d8f10', accentStrong: '#4c7a0c', accentFg: '#ffffff',
  green: '#4b8b16', red: '#c0392b', yellow: '#a9781a', blue: '#2b6cb0', purple: '#7c4dbd',
  termBg: '#fdfdfa', termFg: '#24291f',
  comment: '#4b8b16', keyword: '#3d6b0c', control: '#7c4dbd', str: '#a9781a',
  number: '#2f6f14', fn: '#795e26', type: '#1c7d74', variable: '#24291f',
  constant: '#5d8f10', tag: '#3d6b0c', attr: '#2f6f14', regexp: '#c0392b',
  operator: '#5d6553', meta: '#7c4dbd',
})

// ------------------------------------------------------------------- One ---

const oneDark = tokens({
  dark: true,
  bg: '#282c34', raised: '#21252b', panel: '#21252b', inset: '#1b1d23',
  hover: '#2c313a', active: '#3a3f4b', selected: '#3e4451',
  fg: '#abb2bf', muted: '#8b93a1', subtle: '#5c6370',
  border: '#21252b', borderStrong: '#3e4451',
  accent: '#61afef', accentStrong: '#7ec1ff', accentFg: '#1b1d23',
  green: '#98c379', red: '#e06c75', yellow: '#e5c07b', blue: '#61afef', purple: '#c678dd',
  comment: '#5c6370', keyword: '#c678dd', control: '#c678dd', str: '#98c379',
  number: '#d19a66', fn: '#61afef', type: '#e5c07b', variable: '#e06c75',
  constant: '#d19a66', tag: '#e06c75', attr: '#d19a66', regexp: '#56b6c2',
  operator: '#56b6c2', meta: '#61afef',
})

const oneLight = tokens({
  dark: false,
  bg: '#fafafa', raised: '#ffffff', panel: '#eaeaeb', inset: '#ffffff',
  hover: '#ebebec', active: '#dbdbdc', selected: '#cfe4fa',
  fg: '#383a42', muted: '#696c77', subtle: '#a0a1a7',
  border: '#e5e5e6', borderStrong: '#c9c9ca',
  accent: '#4078f2', accentStrong: '#2f66d8', accentFg: '#ffffff',
  green: '#50a14f', red: '#e45649', yellow: '#c18401', blue: '#4078f2', purple: '#a626a4',
  comment: '#a0a1a7', keyword: '#a626a4', control: '#a626a4', str: '#50a14f',
  number: '#986801', fn: '#4078f2', type: '#c18401', variable: '#e45649',
  constant: '#986801', tag: '#e45649', attr: '#986801', regexp: '#0184bc',
  operator: '#0184bc', meta: '#4078f2',
})

// --------------------------------------------------------------- Dracula ---

const draculaDark = tokens({
  dark: true,
  bg: '#282a36', raised: '#343746', panel: '#21222c', inset: '#1e1f29',
  hover: '#343746', active: '#44475a', selected: '#44475a',
  fg: '#f8f8f2', muted: '#b6b8c4', subtle: '#6272a4',
  border: '#21222c', borderStrong: '#44475a',
  accent: '#bd93f9', accentStrong: '#d6acff', accentFg: '#21222c',
  green: '#50fa7b', red: '#ff5555', yellow: '#f1fa8c', blue: '#8be9fd', purple: '#bd93f9',
  comment: '#6272a4', keyword: '#ff79c6', control: '#ff79c6', str: '#f1fa8c',
  number: '#bd93f9', fn: '#50fa7b', type: '#8be9fd', variable: '#f8f8f2',
  constant: '#bd93f9', tag: '#ff79c6', attr: '#50fa7b', regexp: '#ff5555',
  operator: '#ff79c6', meta: '#8be9fd',
})

/** Alucard, Dracula's official light counterpart. */
const draculaLight = tokens({
  dark: false,
  bg: '#fffbeb', raised: '#ffffff', panel: '#f5f0dc', inset: '#ffffff',
  hover: '#f0ead6', active: '#e6dfc8', selected: '#e0d8f0',
  fg: '#1f1f1f', muted: '#6c664b', subtle: '#8c8570',
  border: '#e6dfc8', borderStrong: '#cfc8b0',
  accent: '#644ac9', accentStrong: '#4f3aa8', accentFg: '#ffffff',
  green: '#14710a', red: '#cb3a2a', yellow: '#846e15', blue: '#036a96', purple: '#644ac9',
  comment: '#8c8570', keyword: '#a3144d', control: '#a3144d', str: '#846e15',
  number: '#644ac9', fn: '#14710a', type: '#036a96', variable: '#1f1f1f',
  constant: '#644ac9', tag: '#a3144d', attr: '#14710a', regexp: '#cb3a2a',
  operator: '#a3144d', meta: '#036a96',
})

// ------------------------------------------------------------------ Nord ---

const nordDark = tokens({
  dark: true,
  bg: '#2e3440', raised: '#3b4252', panel: '#2b313c', inset: '#272c36',
  hover: '#3b4252', active: '#434c5e', selected: '#434c5e',
  fg: '#d8dee9', muted: '#aeb8c8', subtle: '#7b88a1',
  border: '#3b4252', borderStrong: '#4c566a',
  accent: '#88c0d0', accentStrong: '#8fbcbb', accentFg: '#2e3440',
  green: '#a3be8c', red: '#bf616a', yellow: '#ebcb8b', blue: '#81a1c1', purple: '#b48ead',
  comment: '#616e88', keyword: '#81a1c1', control: '#81a1c1', str: '#a3be8c',
  number: '#b48ead', fn: '#88c0d0', type: '#8fbcbb', variable: '#d8dee9',
  constant: '#b48ead', tag: '#81a1c1', attr: '#8fbcbb', regexp: '#ebcb8b',
  operator: '#81a1c1', meta: '#5e81ac',
})

/** Built on Snow Storm, with the Aurora accents deepened enough to read. */
const nordLight = tokens({
  dark: false,
  bg: '#eceff4', raised: '#ffffff', panel: '#e5e9f0', inset: '#ffffff',
  hover: '#dfe4ec', active: '#d8dee9', selected: '#d8dee9',
  fg: '#2e3440', muted: '#4c566a', subtle: '#7b88a1',
  border: '#d8dee9', borderStrong: '#c2cad6',
  accent: '#5e81ac', accentStrong: '#4c6f96', accentFg: '#ffffff',
  green: '#5e7d47', red: '#a54f58', yellow: '#94743a', blue: '#5e81ac', purple: '#8a6a86',
  comment: '#7b88a1', keyword: '#5e81ac', control: '#5e81ac', str: '#5e7d47',
  number: '#8a6a86', fn: '#3f7f8f', type: '#3d7a78', variable: '#2e3440',
  constant: '#8a6a86', tag: '#5e81ac', attr: '#3d7a78', regexp: '#94743a',
  operator: '#5e81ac', meta: '#4c6f96',
})

// ------------------------------------------------------------- Solarized ---

const solarizedDark = tokens({
  dark: true,
  bg: '#002b36', raised: '#073642', panel: '#073642', inset: '#00212b',
  hover: '#073642', active: '#0d4a5a', selected: '#0d4a5a',
  fg: '#839496', muted: '#657b83', subtle: '#586e75',
  border: '#073642', borderStrong: '#0f4a58',
  accent: '#268bd2', accentStrong: '#4aa3e0', accentFg: '#002b36',
  green: '#859900', red: '#dc322f', yellow: '#b58900', blue: '#268bd2', purple: '#6c71c4',
  comment: '#586e75', keyword: '#859900', control: '#cb4b16', str: '#2aa198',
  number: '#d33682', fn: '#268bd2', type: '#b58900', variable: '#268bd2',
  constant: '#d33682', tag: '#268bd2', attr: '#93a1a1', regexp: '#dc322f',
  operator: '#859900', meta: '#6c71c4',
})

const solarizedLight = tokens({
  dark: false,
  bg: '#fdf6e3', raised: '#fdf6e3', panel: '#eee8d5', inset: '#fdf6e3',
  hover: '#eee8d5', active: '#e4ddc8', selected: '#ddd6c1',
  fg: '#657b83', muted: '#586e75', subtle: '#93a1a1',
  border: '#eee8d5', borderStrong: '#d9d2bd',
  accent: '#268bd2', accentStrong: '#1e6fa8', accentFg: '#ffffff',
  green: '#859900', red: '#dc322f', yellow: '#b58900', blue: '#268bd2', purple: '#6c71c4',
  comment: '#93a1a1', keyword: '#859900', control: '#cb4b16', str: '#2aa198',
  number: '#d33682', fn: '#268bd2', type: '#b58900', variable: '#268bd2',
  constant: '#d33682', tag: '#268bd2', attr: '#586e75', regexp: '#dc322f',
  operator: '#859900', meta: '#6c71c4',
})

// ------------------------------------------------------------ Catppuccin ---

/** Mocha. */
const catppuccinDark = tokens({
  dark: true,
  bg: '#1e1e2e', raised: '#313244', panel: '#181825', inset: '#11111b',
  hover: '#313244', active: '#45475a', selected: '#45475a',
  fg: '#cdd6f4', muted: '#a6adc8', subtle: '#6c7086',
  border: '#313244', borderStrong: '#45475a',
  accent: '#89b4fa', accentStrong: '#b4befe', accentFg: '#1e1e2e',
  green: '#a6e3a1', red: '#f38ba8', yellow: '#f9e2af', blue: '#89b4fa', purple: '#cba6f7',
  comment: '#6c7086', keyword: '#cba6f7', control: '#cba6f7', str: '#a6e3a1',
  number: '#fab387', fn: '#89b4fa', type: '#f9e2af', variable: '#cdd6f4',
  constant: '#fab387', tag: '#89b4fa', attr: '#f9e2af', regexp: '#f5c2e7',
  operator: '#89dceb', meta: '#f5c2e7',
})

/** Latte. */
const catppuccinLight = tokens({
  dark: false,
  bg: '#eff1f5', raised: '#ffffff', panel: '#e6e9ef', inset: '#ffffff',
  hover: '#dce0e8', active: '#ccd0da', selected: '#ccd0da',
  fg: '#4c4f69', muted: '#6c6f85', subtle: '#9ca0b0',
  border: '#dce0e8', borderStrong: '#bcc0cc',
  accent: '#1e66f5', accentStrong: '#1a56d0', accentFg: '#ffffff',
  green: '#40a02b', red: '#d20f39', yellow: '#df8e1d', blue: '#1e66f5', purple: '#8839ef',
  comment: '#9ca0b0', keyword: '#8839ef', control: '#8839ef', str: '#40a02b',
  number: '#fe640b', fn: '#1e66f5', type: '#df8e1d', variable: '#4c4f69',
  constant: '#fe640b', tag: '#1e66f5', attr: '#df8e1d', regexp: '#ea76cb',
  operator: '#04a5e5', meta: '#ea76cb',
})

// ---------------------------------------------------------------- registry --

export const UI_THEMES: UiTheme[] = [
  {
    id: 'vscode', name: 'VS Code',
    dark: vscodeDark, light: vscodeLight,
    terminal: { dark: 'vscode-dark', light: 'vscode-light' },
  },
  {
    id: 'one', name: 'One',
    dark: oneDark, light: oneLight,
    terminal: { dark: 'one-dark', light: 'one-light' },
  },
  {
    id: 'dracula', name: 'Dracula',
    dark: draculaDark, light: draculaLight,
    terminal: { dark: 'dracula', light: 'alucard' },
  },
  {
    id: 'nord', name: 'Nord',
    dark: nordDark, light: nordLight,
    terminal: { dark: 'nord', light: 'nord-light' },
  },
  {
    id: 'solarized', name: 'Solarized',
    dark: solarizedDark, light: solarizedLight,
    terminal: { dark: 'solarized-dark', light: 'solarized-light' },
  },
  {
    id: 'catppuccin', name: 'Catppuccin',
    dark: catppuccinDark, light: catppuccinLight,
    terminal: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
  },
  {
    id: 'almaware', name: 'Almaware',
    dark: almawareDark, light: almawareLight,
    terminal: { dark: 'almaware-dark', light: 'almaware-light' },
  },
]

export const DEFAULT_UI_THEME = 'vscode'

export function resolveUiTheme(id: string): UiTheme {
  return UI_THEMES.find((t) => t.id === id) ?? UI_THEMES[0]
}

/** Writes a theme's variant onto an element as CSS custom properties. */
export function applyTokens(el: HTMLElement, theme: UiTheme, dark: boolean) {
  const values = dark ? theme.dark : theme.light
  for (const name of TOKENS) {
    el.style.setProperty(`--${name}`, values[name])
  }
}
