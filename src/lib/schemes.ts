/** Terminal colour schemes offered in Settings.
 *
 * `auto` is the default: it derives from the app theme so the terminal always
 * matches the surrounding chrome without the user configuring anything. */

import type { UiTheme } from './uiThemes'

export interface TermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string; red: string; green: string; yellow: string
  blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}

const almawareDark: TermTheme = {
  background: '#0a0c08', foreground: '#d8ddd0',
  cursor: '#99d420', cursorAccent: '#0a0c08', selectionBackground: '#31421a',
  black: '#1a1f14', red: '#e5605f', green: '#8fce30', yellow: '#d9b23c',
  blue: '#62a8de', magenta: '#b18ce0', cyan: '#4fb8ad', white: '#c9cfbf',
  brightBlack: '#5c6553', brightRed: '#ff7d7c', brightGreen: '#aee84a', brightYellow: '#f0cb5a',
  brightBlue: '#84c2f0', brightMagenta: '#c9a8f0', brightCyan: '#6fd6ca', brightWhite: '#eef1e7',
}

const almawareLight: TermTheme = {
  background: '#fdfdfa', foreground: '#24291f',
  cursor: '#5d8f10', cursorAccent: '#ffffff', selectionBackground: '#d5e4b4',
  black: '#2b3124', red: '#c0392b', green: '#4b8b16', yellow: '#a9781a',
  blue: '#2b6cb0', magenta: '#7c4dbd', cyan: '#1c7d74', white: '#e3e5da',
  brightBlack: '#6d7563', brightRed: '#d9483a', brightGreen: '#5da51c', brightYellow: '#c08f22',
  brightBlue: '#3a83ce', brightMagenta: '#945fd6', brightCyan: '#249589', brightWhite: '#ffffff',
}

const oneDark: TermTheme = {
  background: '#282c34', foreground: '#abb2bf',
  cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451',
  black: '#3f4451', red: '#e05561', green: '#8cc265', yellow: '#d18f52',
  blue: '#4aa5f0', magenta: '#c162de', cyan: '#42b3c2', white: '#d7dae0',
  brightBlack: '#4f5666', brightRed: '#ff616e', brightGreen: '#a5e075', brightYellow: '#f0a45d',
  brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#e6e6e6',
}

const nord: TermTheme = {
  background: '#2e3440', foreground: '#d8dee9',
  cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
  black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
  blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
  brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
}

const solarizedDark: TermTheme = {
  background: '#002b36', foreground: '#93a1a1',
  cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
  black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
  blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
  brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
  brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
}

const gruvboxDark: TermTheme = {
  background: '#282828', foreground: '#ebdbb2',
  cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
  black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
  blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
  brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
  brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
}

// VS Code's integrated-terminal ANSI palette, Dark+.
const vscodeDark: TermTheme = {
  background: '#1e1e1e', foreground: '#cccccc',
  cursor: '#aeafad', cursorAccent: '#1e1e1e', selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
}

// VS Code's integrated-terminal ANSI palette, Light+.
const vscodeLight: TermTheme = {
  background: '#ffffff', foreground: '#3b3b3b',
  cursor: '#000000', cursorAccent: '#ffffff', selectionBackground: '#add6ff',
  black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
  blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00',
  brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
}

const githubLight: TermTheme = {
  background: '#ffffff', foreground: '#24292f',
  cursor: '#0969da', cursorAccent: '#ffffff', selectionBackground: '#c8e1ff',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
  brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
}

export const SCHEMES: Record<string, TermTheme> = {
  'vscode-dark': vscodeDark,
  'vscode-light': vscodeLight,
  'almaware-dark': almawareDark,
  'almaware-light': almawareLight,
  'one-dark': oneDark,
  nord,
  'solarized-dark': solarizedDark,
  'gruvbox-dark': gruvboxDark,
  'github-light': githubLight,
}

export const SCHEME_NAMES: Record<string, string> = {
  auto: 'Match the app theme',
  'vscode-dark': 'VS Code Dark+',
  'vscode-light': 'VS Code Light+',
  'almaware-dark': 'Almaware Dark',
  'almaware-light': 'Almaware Light',
  'one-dark': 'One Dark',
  nord: 'Nord',
  'solarized-dark': 'Solarized Dark',
  'gruvbox-dark': 'Gruvbox Dark',
  'github-light': 'GitHub Light',
}

/**
 * `auto` defers to the active UI theme, which names the terminal scheme that
 * belongs with it — so switching the app theme moves the terminal too.
 */
export function resolveScheme(name: string, isDark: boolean, uiTheme?: UiTheme): TermTheme {
  if (name !== 'auto' && SCHEMES[name]) return SCHEMES[name]
  const paired = uiTheme && (isDark ? uiTheme.terminal.dark : uiTheme.terminal.light)
  if (paired && SCHEMES[paired]) return SCHEMES[paired]
  return isDark ? vscodeDark : vscodeLight
}
