import { describe, expect, it } from 'vitest'
import { SCHEMES } from './schemes'
import { parseHex } from './color'
import { applyTokens, DEFAULT_UI_THEME, resolveUiTheme, TOKENS, UI_THEMES } from './uiThemes'

/** Guards the theme data itself, which is the part most likely to go wrong as
 *  themes are added: a missed token leaves a colour undefined at runtime, and
 *  a mistyped scheme id silently falls back. */
describe('theme registry', () => {
  it('has unique ids and a resolvable default', () => {
    const ids = UI_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_UI_THEME)
    expect(resolveUiTheme(DEFAULT_UI_THEME).id).toBe(DEFAULT_UI_THEME)
  })

  it('falls back to the first theme for an unknown id', () => {
    expect(resolveUiTheme('no-such-theme').id).toBe(UI_THEMES[0].id)
  })

  for (const theme of UI_THEMES) {
    describe(theme.name, () => {
      for (const variant of ['dark', 'light'] as const) {
        it(`defines every token in its ${variant} variant`, () => {
          const values = theme[variant]
          const missing = TOKENS.filter((t) => !values[t] || values[t].trim() === '')
          expect(missing).toEqual([])
        })

        it(`uses parseable colours for ${variant} surfaces and syntax`, () => {
          const values = theme[variant]
          const colourTokens = TOKENS.filter(
            (t) => !t.startsWith('shadow') && !t.startsWith('diff-'),
          )
          const bad = colourTokens.filter((t) => parseHex(values[t]) === null)
          expect(bad).toEqual([])
        })
      }

      it('points at terminal schemes that exist', () => {
        expect(SCHEMES[theme.terminal.dark], theme.terminal.dark).toBeDefined()
        expect(SCHEMES[theme.terminal.light], theme.terminal.light).toBeDefined()
      })

      it('keeps its dark variant darker than its light one', () => {
        // Catches a copy-paste that leaves both variants on the same palette.
        const dark = parseHex(theme.dark.bg)!
        const light = parseHex(theme.light.bg)!
        const sum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b
        expect(sum(dark)).toBeLessThan(sum(light))
      })
    })
  }

  it('writes every token onto the element it is applied to', () => {
    const el = document.createElement('div')
    applyTokens(el, UI_THEMES[0], true)
    for (const token of TOKENS) {
      expect(el.style.getPropertyValue(`--${token}`), token).not.toBe('')
    }
  })
})

describe('terminal schemes', () => {
  const KEYS = [
    'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ] as const

  for (const [id, scheme] of Object.entries(SCHEMES)) {
    it(`${id} defines all 21 colours as valid hex`, () => {
      const bad = KEYS.filter((k) => parseHex(scheme[k]) === null)
      expect(bad).toEqual([])
    })
  }
})
