import { describe, expect, it } from 'vitest'
import { pairChangedLines, wordDiff } from './wordDiff'

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')
const changed = (segs: { text: string; changed: boolean }[]) =>
  segs.filter((s) => s.changed).map((s) => s.text)

describe('wordDiff', () => {
  it('marks only the words that actually differ', () => {
    const { removed, added } = wordDiff(
      'const total = price * quantity',
      'const total = price * amount',
    )
    expect(changed(removed)).toEqual(['quantity'])
    expect(changed(added)).toEqual(['amount'])
  })

  it('reconstructs both original lines exactly', () => {
    const a = '  return foo(bar, baz)'
    const b = '  return foo(qux, baz, extra)'
    const { removed, added } = wordDiff(a, b)
    expect(text(removed)).toBe(a)
    expect(text(added)).toBe(b)
  })

  it('marks nothing when the lines are identical', () => {
    const { removed, added } = wordDiff('same line', 'same line')
    expect(changed(removed)).toEqual([])
    expect(changed(added)).toEqual([])
  })

  it('handles a pure insertion', () => {
    const { removed, added } = wordDiff('a c', 'a b c')
    expect(changed(removed)).toEqual([])
    expect(changed(added).join('')).toContain('b')
  })

  it('falls back to whole-line marking on pathological input', () => {
    // Long minified lines would make the LCS table quadratic and huge.
    const a = 'x'.repeat(400).split('').join(' ')
    const b = 'y'.repeat(400).split('').join(' ')
    const { removed, added } = wordDiff(a, b)
    expect(removed).toEqual([{ text: a, changed: true }])
    expect(added).toEqual([{ text: b, changed: true }])
  })

  it('copes with empty lines on either side', () => {
    expect(text(wordDiff('', 'added').added)).toBe('added')
    expect(text(wordDiff('removed', '').removed)).toBe('removed')
  })
})

describe('pairChangedLines', () => {
  const lines = (...origins: string[]) => origins.map((origin) => ({ origin }))

  it('pairs a balanced run of removals and additions', () => {
    const pairs = pairChangedLines(lines(' ', '-', '-', '+', '+', ' '))
    expect([...pairs.entries()]).toEqual([[1, 3], [2, 4]])
  })

  it('does not pair an unbalanced run', () => {
    // Three lines replaced by one has no sensible line-to-line mapping.
    expect(pairChangedLines(lines('-', '-', '-', '+')).size).toBe(0)
  })

  it('ignores context-only hunks', () => {
    expect(pairChangedLines(lines(' ', ' ', ' ')).size).toBe(0)
  })

  it('handles several separate runs in one hunk', () => {
    const pairs = pairChangedLines(lines('-', '+', ' ', ' ', '-', '+'))
    expect([...pairs.entries()]).toEqual([[0, 1], [4, 5]])
  })

  it('does not pair additions that stand alone', () => {
    expect(pairChangedLines(lines(' ', '+', '+')).size).toBe(0)
  })
})
