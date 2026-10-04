import { useColorScheme } from 'react-native'

/** The desktop's default look (VS Code Dark+ / Light+), carried over. */
export interface Palette {
  bg: string
  panel: string
  raised: string
  border: string
  fg: string
  muted: string
  subtle: string
  accent: string
  accentFg: string
  red: string
  green: string
  yellow: string
  termBg: string
  termFg: string
}

const dark: Palette = {
  bg: '#181818',
  panel: '#1f1f1f',
  raised: '#2a2a2a',
  border: '#2b2b2b',
  fg: '#cccccc',
  muted: '#9d9d9d',
  subtle: '#6e7681',
  accent: '#7cb518',
  accentFg: '#0b1400',
  red: '#f85149',
  green: '#2ea043',
  yellow: '#d29922',
  termBg: '#1e1e1e',
  termFg: '#cccccc',
}

const light: Palette = {
  bg: '#f8f8f8',
  panel: '#ffffff',
  raised: '#ffffff',
  border: '#e5e5e5',
  fg: '#3b3b3b',
  muted: '#616161',
  subtle: '#8b949e',
  accent: '#5a8a0c',
  accentFg: '#ffffff',
  red: '#d1242f',
  green: '#1a7f37',
  yellow: '#9a6700',
  termBg: '#ffffff',
  termFg: '#3b3b3b',
}

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark
}

/** xterm theme for the terminal page. */
export function terminalTheme(p: Palette, isDark: boolean) {
  return isDark
    ? {
        background: p.termBg, foreground: p.termFg, cursor: '#aeafad', selectionBackground: '#264f78',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8',
        magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666',
        brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea',
        brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
      }
    : {
        background: p.termBg, foreground: p.termFg, cursor: '#000000', selectionBackground: '#add6ff',
        black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5',
        magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666',
        brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5',
        brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
      }
}
