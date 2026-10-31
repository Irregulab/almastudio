/** Which grammar the editor uses for a file.
 *
 * The list is CodeMirror's own catalogue, in which every language is a chunk of
 * its own, loaded the first time a file needs it. This file only adds what the
 * catalogue misses, or gets wrong for the files found in a project.
 */

import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/** Extensions the catalogue lacks, or gives to something rarer. */
const BY_EXTENSION: Record<string, string> = {
  cfg: 'Properties files',
  conf: 'Properties files',
  env: 'Properties files',
  fish: 'Shell',
  json5: 'JSON',
  jsonc: 'JSON',
  m: 'Objective-C',
  mdx: 'Markdown',
  pyi: 'Python',
  svelte: 'HTML',
  zsh: 'Shell',
}

/** The catalogue reads `.text` as LaTeX and `app.log.1` as a man page. */
const PLAIN_TEXT = /^(text|\d)$/

const named = (name: string) => LanguageDescription.matchLanguageName(languages, name, false)

export function describeFile(path: string): LanguageDescription | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const lower = name.toLowerCase()
  const extension = lower.includes('.') ? lower.split('.').pop()! : ''

  // Ahead of extensions, so nginx.conf is Nginx and not just any .conf.
  const byName = languages.find((language) => language.filename?.test(name))
  if (byName) return byName

  if (lower.startsWith('dockerfile')) return named('Dockerfile')
  // There is no grammar for Make, but its comments, variables and recipes read
  // well enough as shell.
  if (lower === 'makefile' || lower === 'gnumakefile') return named('Shell')
  if (PLAIN_TEXT.test(extension)) return null
  if (BY_EXTENSION[extension]) return named(BY_EXTENSION[extension])

  return (
    LanguageDescription.matchFilename(languages, name) ??
    LanguageDescription.matchFilename(languages, lower)
  )
}

/** Null when there is no grammar. Highlighting is decoration, so a grammar that
 *  fails to load leaves plain text rather than no editor. */
export async function languageFor(path: string) {
  try {
    return (await describeFile(path)?.load()) ?? null
  } catch {
    return null
  }
}
