import { describe, expect, it } from 'vitest'
import { luminance, parseHex, readableAccent } from './color'

describe('parseHex', () => {
  it('accepts long, short and unprefixed forms', () => {
    expect(parseHex('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('7cb518')).toEqual({ r: 124, g: 181, b: 24 })
  })

  it('rejects anything that is not a hex colour', () => {
    expect(parseHex('rebeccapurple')).toBeNull()
    expect(parseHex('#12')).toBeNull()
    expect(parseHex('')).toBeNull()
  })
})

describe('readableAccent', () => {
  const lum = (hex: string) => luminance(parseHex(hex)!)

  it('leaves the presets alone on both themes', () => {
    for (const preset of ['#7cb518', '#4a9ede', '#e0973c', '#d1594f', '#9b6bdb']) {
      expect(readableAccent(preset, true)).toBe(preset)
      expect(readableAccent(preset, false)).toBe(preset)
    }
  })

  it('lifts a near-black colour so it reads on a dark theme', () => {
    const lifted = readableAccent('#101010', true)
    expect(lifted).not.toBe('#101010')
    expect(lum(lifted)).toBeGreaterThan(lum('#101010'))
  })

  it('deepens a near-white colour so it reads on a light theme', () => {
    const deepened = readableAccent('#fafafa', false)
    expect(deepened).not.toBe('#fafafa')
    expect(lum(deepened)).toBeLessThan(lum('#fafafa'))
  })

  it('does not touch a dark colour on a light theme, or a light one on dark', () => {
    expect(readableAccent('#101010', false)).toBe('#101010')
    expect(readableAccent('#fafafa', true)).toBe('#fafafa')
  })

  it('keeps the hue rather than collapsing to white or black', () => {
    const lifted = parseHex(readableAccent('#0a0033', true))!
    // Still recognisably blue-violet: blue stays the dominant channel.
    expect(lifted.b).toBeGreaterThan(lifted.r)
    expect(lifted.b).toBeGreaterThan(lifted.g)
  })

  it('passes through an unparseable value unchanged', () => {
    expect(readableAccent('var(--accent)', true)).toBe('var(--accent)')
  })
})
