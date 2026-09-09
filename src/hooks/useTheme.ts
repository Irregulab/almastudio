import { useEffect, useState } from 'react'
import { applyTokens, resolveUiTheme } from '../lib/uiThemes'
import { useSettings } from '../store/settings'

const query = () => window.matchMedia('(prefers-color-scheme: dark)')

/** Resolves theme mode + OS preference into a single "is dark" boolean. */
export function useTheme(): boolean {
  const mode = useSettings((s) => s.settings.theme)
  const [systemDark, setSystemDark] = useState(() => query().matches)

  useEffect(() => {
    const mq = query()
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return mode === 'system' ? systemDark : mode === 'dark'
}

/** Applies theme, accent and font settings to the document root. */
export function useApplyTheme() {
  const settings = useSettings((s) => s.settings)
  const isDark = useTheme()

  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  // The whole palette comes from the theme registry, so a new theme is a data
  // change rather than a stylesheet change. The CSS keeps matching fallbacks
  // for the first paint before this runs.
  useEffect(() => {
    const theme = resolveUiTheme(settings.uiTheme)
    applyTokens(document.documentElement, theme, isDark)
  }, [settings.uiTheme, isDark])

  // An explicit accent overrides the theme's, and is applied after it.
  useEffect(() => {
    const root = document.documentElement
    if (!settings.accent) return
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty(
      '--accent-strong',
      `color-mix(in srgb, ${settings.accent} 84%, ${isDark ? 'white' : 'black'})`,
    )
  }, [settings.accent, settings.uiTheme, isDark])

  useEffect(() => {
    const root = document.documentElement
    if (settings.ui.fontFamily) root.style.setProperty('--font-ui', settings.ui.fontFamily)
    else root.style.removeProperty('--font-ui')
    root.style.setProperty('--font-ui-size', `${settings.ui.fontSize}px`)
    root.dataset.density = settings.ui.density
  }, [settings.ui.fontFamily, settings.ui.fontSize, settings.ui.density])

  return isDark
}
