/** Syntax highlighting.
 *
 * highlight.js core plus an explicit language list, loaded on first use as its
 * own chunk — a workspace that only ever shows terminals never pays for it.
 * Output is converted into per-line token arrays rather than an HTML string so
 * the file view can render React elements and keep line numbers in a table,
 * with no `dangerouslySetInnerHTML` anywhere near file content.
 */

import type { HLJSApi } from 'highlight.js'

/** Files larger than this are shown unhighlighted; tokenising them stalls the UI. */
const MAX_HIGHLIGHT_BYTES = 400 * 1024

export interface SynToken {
  text: string
  /** Space-separated hljs class names, or '' for plain text. */
  cls: string
}
export type SynLine = SynToken[]

let loading: Promise<HLJSApi> | null = null

async function loadHljs(): Promise<HLJSApi> {
  if (loading) return loading
  loading = (async () => {
    const { default: hljs } = await import('highlight.js/lib/core')
    const mods = await Promise.all([
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/rust'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/go'),
      import('highlight.js/lib/languages/java'),
      import('highlight.js/lib/languages/kotlin'),
      import('highlight.js/lib/languages/c'),
      import('highlight.js/lib/languages/cpp'),
      import('highlight.js/lib/languages/csharp'),
      import('highlight.js/lib/languages/ruby'),
      import('highlight.js/lib/languages/php'),
      import('highlight.js/lib/languages/swift'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/ini'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/scss'),
      import('highlight.js/lib/languages/less'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/dockerfile'),
      import('highlight.js/lib/languages/makefile'),
      import('highlight.js/lib/languages/graphql'),
      import('highlight.js/lib/languages/lua'),
      import('highlight.js/lib/languages/diff'),
      import('highlight.js/lib/languages/plaintext'),
    ])
    const names = [
      'typescript', 'javascript', 'json', 'rust', 'python', 'go', 'java',
      'kotlin', 'c', 'cpp', 'csharp', 'ruby', 'php', 'swift', 'bash', 'yaml',
      'ini', 'xml', 'css', 'scss', 'less', 'sql', 'markdown', 'dockerfile',
      'makefile', 'graphql', 'lua', 'diff', 'plaintext',
    ]
    mods.forEach((m, i) => hljs.registerLanguage(names[i], m.default))
    hljs.configure({ classPrefix: 'hljs-', ignoreUnescapedHTML: true })
    return hljs
  })()
  return loading
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  rs: 'rust', py: 'python', pyi: 'python', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  sql: 'sql', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  graphql: 'graphql', gql: 'graphql', lua: 'lua', diff: 'diff', patch: 'diff',
}

const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitignore': 'plaintext',
  '.env': 'ini',
}

/** Best-guess language id for a path, or null when we have no grammar for it. */
export function languageOf(path: string): string | null {
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
  if (BY_FILENAME[name]) return BY_FILENAME[name]
  if (name.startsWith('dockerfile')) return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return BY_EXTENSION[ext] ?? null
}

export const isMarkdown = (path: string) => languageOf(path) === 'markdown'

/**
 * Splits highlight.js output into lines of class-tagged runs.
 *
 * The markup nests, and a single span can straddle a newline (a block comment,
 * a template literal), so this walks the parsed tree carrying the class chain
 * down and starts a new line whenever a text node contains one.
 */
function toLines(html: string): SynLine[] {
  const doc = new DOMParser().parseFromString(`<pre>${html}</pre>`, 'text/html')
  const root = doc.body.firstChild
  const lines: SynLine[] = [[]]
  if (!root) return lines

  const walk = (node: Node, cls: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? '').split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1].push({ text: part, cls })
      })
      return
    }
    const el = node as Element
    const next = el.className ? `${cls} ${el.className}`.trim() : cls
    el.childNodes.forEach((child) => walk(child, next))
  }
  root.childNodes.forEach((child) => walk(child, ''))
  return lines
}

/** Highlighted lines, or null when the file is too big or has no grammar. */
export async function highlightLines(
  code: string,
  language: string | null,
): Promise<SynLine[] | null> {
  if (!language || code.length > MAX_HIGHLIGHT_BYTES) return null
  try {
    const hljs = await loadHljs()
    if (!hljs.getLanguage(language)) return null
    return toLines(hljs.highlight(code, { language, ignoreIllegals: true }).value)
  } catch {
    // Highlighting is decoration; never let it take the file view down.
    return null
  }
}

/** Splits plain text the same way, so both paths render identically. */
export const plainLines = (code: string): SynLine[] =>
  code.split('\n').map((line) => (line ? [{ text: line, cls: '' }] : []))

export { loadHljs }

// --------------------------------------------------------------- merging ---

export interface MergedRun {
  text: string
  /** hljs classes for this run. */
  cls: string
  /** True when the run falls inside an intra-line diff change. */
  changed: boolean
}

/**
 * Overlays word-diff segments onto syntax tokens for the same line.
 *
 * Both describe the same string as an ordered partition, so this walks the two
 * in lockstep and cuts a new run at every boundary from either side. The
 * result carries the syntax colour and the changed flag together, which is
 * what lets a diff line show a renamed identifier highlighted *and* coloured
 * as an identifier.
 */
export function mergeSyntaxAndWords(
  syntax: SynLine,
  segments: Array<{ text: string; changed: boolean }>,
): MergedRun[] {
  const out: MergedRun[] = []
  let i = 0
  let j = 0
  let si = 0
  let gi = 0

  while (i < syntax.length && j < segments.length) {
    const take = Math.min(syntax[i].text.length - si, segments[j].text.length - gi)
    if (take <= 0) break
    out.push({
      text: syntax[i].text.substr(si, take),
      cls: syntax[i].cls,
      changed: segments[j].changed,
    })
    si += take
    gi += take
    if (si >= syntax[i].text.length) {
      i++
      si = 0
    }
    if (gi >= segments[j].text.length) {
      j++
      gi = 0
    }
  }

  // The two partitions should cover the same string; if a grammar ever
  // disagrees, emit the remainder rather than silently dropping characters.
  for (; i < syntax.length; i++, si = 0) {
    const text = syntax[i].text.slice(si)
    if (text) out.push({ text, cls: syntax[i].cls, changed: false })
  }
  for (; j < segments.length; j++, gi = 0) {
    const text = segments[j].text.slice(gi)
    if (text) out.push({ text, cls: '', changed: segments[j].changed })
  }
  return out
}
