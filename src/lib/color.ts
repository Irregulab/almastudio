/** Keeping a user-chosen colour visible against the current theme.
 *
 * Project colours are free-form, and a very dark one on a dark theme (or a
 * very light one on light) would make the tab highlight and the activity dots
 * effectively invisible. Rather than restricting the picker, the colour is
 * nudged toward the readable end only when it needs to be — the presets and
 * anything reasonably saturated pass through untouched.
 */

interface Rgb {
  r: number
  g: number
  b: number
}

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = m[1]
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

const mix = (a: Rgb, b: Rgb, amount: number): Rgb => ({
  r: a.r + (b.r - a.r) * amount,
  g: a.g + (b.g - a.g) * amount,
  b: a.b + (b.b - a.b) * amount,
})

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** Floor / ceiling luminance for a colour used as chrome on each theme. */
const MIN_ON_DARK = 0.16
const MAX_ON_LIGHT = 0.62

/**
 * Returns the colour as given when it reads clearly, or lifted toward white
 * (on dark themes) / deepened toward black (on light ones) when it does not.
 */
export function readableAccent(hex: string, isDark: boolean): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex

  let out = rgb
  if (isDark) {
    // Step toward white until it clears the floor, bounded so a deliberate
    // dark colour still reads as itself rather than turning into white.
    for (let i = 0; i < 8 && luminance(out) < MIN_ON_DARK; i++) {
      out = mix(out, WHITE, 0.15)
    }
  } else {
    for (let i = 0; i < 8 && luminance(out) > MAX_ON_LIGHT; i++) {
      out = mix(out, BLACK, 0.12)
    }
  }
  return toHex(out)
}
