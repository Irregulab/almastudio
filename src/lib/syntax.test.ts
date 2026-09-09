import { describe, expect, it } from 'vitest'
import { isMarkdown, languageOf, mergeSyntaxAndWords, plainLines } from './syntax'

const text = (runs: { text: string }[]) => runs.map((r) => r.text).join('')

describe('languageOf', () => {
  it('maps common extensions', () => {
    expect(languageOf('src/App.tsx')).toBe('typescript')
    expect(languageOf('main.rs')).toBe('rust')
    expect(languageOf('Cargo.toml')).toBe('ini')
    expect(languageOf('styles/app.css')).toBe('css')
    expect(languageOf('deploy.sh')).toBe('bash')
  })

  it('recognises extensionless filenames', () => {
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('build/Dockerfile.prod')).toBe('dockerfile')
    expect(languageOf('Makefile')).toBe('makefile')
  })

  it('returns null when there is no grammar for it', () => {
    expect(languageOf('photo.heic')).toBeNull()
    expect(languageOf('LICENSE')).toBeNull()
  })

  it('detects markdown', () => {
    expect(isMarkdown('README.md')).toBe(true)
    expect(isMarkdown('docs/UPDATES.markdown')).toBe(true)
    expect(isMarkdown('index.html')).toBe(false)
  })
})

describe('plainLines', () => {
  it('produces one entry per line and keeps blanks empty', () => {
    expect(plainLines('a\n\nb')).toEqual([
      [{ text: 'a', cls: '' }],
      [],
      [{ text: 'b', cls: '' }],
    ])
  })

  it('matches the line count of the source', () => {
    const src = 'one\ntwo\nthree\n'
    expect(plainLines(src)).toHaveLength(src.split('\n').length)
  })
})

describe('mergeSyntaxAndWords', () => {
  const syn = [
    { text: 'const ', cls: 'hljs-keyword' },
    { text: 'total', cls: 'hljs-variable' },
    { text: ' = quantity', cls: '' },
  ]

  it('cuts a run at every boundary from either side', () => {
    const segs = [
      { text: 'const total = ', changed: false },
      { text: 'quantity', changed: true },
    ]
    const runs = mergeSyntaxAndWords(syn, segs)

    // The string is preserved exactly.
    expect(text(runs)).toBe('const total = quantity')
    // The changed word keeps its syntax class as well as the changed flag.
    const changedRuns = runs.filter((r) => r.changed)
    expect(text(changedRuns)).toBe('quantity')
    // The keyword stays a keyword.
    expect(runs.find((r) => r.text.startsWith('const'))?.cls).toBe('hljs-keyword')
  })

  it('splits a syntax token that a change starts inside', () => {
    const runs = mergeSyntaxAndWords(syn, [
      { text: 'const to', changed: false },
      { text: 'tal', changed: true },
      { text: ' = quantity', changed: false },
    ])
    expect(text(runs)).toBe('const total = quantity')
    const changed = runs.filter((r) => r.changed)
    expect(text(changed)).toBe('tal')
    // Both halves of the split token keep the variable class.
    expect(changed[0].cls).toBe('hljs-variable')
  })

  it('marks nothing when no segment changed', () => {
    const runs = mergeSyntaxAndWords(syn, [
      { text: 'const total = quantity', changed: false },
    ])
    expect(runs.every((r) => !r.changed)).toBe(true)
    expect(text(runs)).toBe('const total = quantity')
  })

  it('preserves characters when the two partitions disagree in length', () => {
    // Defensive: a grammar that dropped or added text must not silently eat
    // part of the line.
    const short = [{ text: 'const', cls: 'hljs-keyword' }]
    const long = [{ text: 'const total', changed: true }]
    expect(text(mergeSyntaxAndWords(short, long))).toBe('const total')
    expect(text(mergeSyntaxAndWords(long.map((s) => ({ text: s.text, cls: '' })), [
      { text: 'const', changed: false },
    ]))).toBe('const total')
  })

  it('handles empty input on either side', () => {
    expect(mergeSyntaxAndWords([], [])).toEqual([])
    expect(text(mergeSyntaxAndWords([{ text: 'x', cls: '' }], []))).toBe('x')
    expect(text(mergeSyntaxAndWords([], [{ text: 'y', changed: true }]))).toBe('y')
  })
})
