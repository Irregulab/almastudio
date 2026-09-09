/** Minimal i18n: flat key lookup with {placeholder} interpolation.
 *
 * Deliberately dependency-free — the whole runtime is ~40 lines and adding a
 * language means dropping in one more JSON file next to these two. */

import { create } from 'zustand'
import type { Language } from '../lib/types'
import en from './en.json'
import it from './it.json'

const BUNDLES = { en, it } as const
export type LocaleCode = keyof typeof BUNDLES
export const AVAILABLE_LOCALES: LocaleCode[] = ['en', 'it']
export const LOCALE_NAMES: Record<LocaleCode, string> = { en: 'English', it: 'Italiano' }

type Nested = { [k: string]: string | Nested }

function flatten(obj: Nested, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else flatten(v, key, out)
  }
  return out
}

const FLAT: Record<LocaleCode, Record<string, string>> = {
  en: flatten(en as Nested),
  it: flatten(it as Nested),
}

let active: LocaleCode = 'en'

/** Maps an OS locale like `it-IT` onto a bundle we actually ship. */
export function resolveLocale(pref: Language, systemLocale: string | null): LocaleCode {
  if (pref !== 'system') return pref
  const base = (systemLocale || 'en').toLowerCase().split(/[-_]/)[0]
  return (AVAILABLE_LOCALES as string[]).includes(base) ? (base as LocaleCode) : 'en'
}

interface I18nState {
  locale: LocaleCode
  setLocale: (l: LocaleCode) => void
}

export const useI18n = create<I18nState>((set) => ({
  locale: 'en',
  setLocale: (l) => {
    active = l
    document.documentElement.lang = l
    set({ locale: l })
  },
}))

/** Translate. Falls back to English, then to the key itself. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = FLAT[active][key] ?? FLAT.en[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : m,
  )
}

/** Hook form: re-renders the component when the language changes. */
export function useT() {
  useI18n((s) => s.locale)
  return t
}

/** The subset the native menu needs, in the current language. */
export function menuLabels(): Record<string, string> {
  const src = FLAT[active]
  return Object.fromEntries(
    Object.entries(src).filter(([k]) => k.startsWith('menu.')),
  )
}
