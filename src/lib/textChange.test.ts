import { describe, expect, it } from 'vitest'

import { changedRange } from './textChange'

const apply = (text: string, { from, to, insert }: ReturnType<typeof changedRange>) =>
  text.slice(0, from) + insert + text.slice(to)

describe('changedRange', () => {
  it('narrows a change to what differs', () => {
    expect(changedRange('one\ntwo\nthree', 'one\n2\nthree')).toEqual({ from: 4, to: 7, insert: '2' })
  })

  it('handles text added and removed', () => {
    expect(changedRange('ac', 'abc')).toEqual({ from: 1, to: 1, insert: 'b' })
    expect(changedRange('abc', 'ac')).toEqual({ from: 1, to: 2, insert: '' })
  })

  it('does not count a character twice when the two ends overlap', () => {
    expect(apply('aaa', changedRange('aaa', 'aa'))).toBe('aa')
    expect(apply('aa', changedRange('aa', 'aaa'))).toBe('aaa')
    expect(apply('abab', changedRange('abab', 'ab'))).toBe('ab')
  })

  it('is empty for identical text', () => {
    expect(changedRange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' })
  })

  it('copes with empty text on either side', () => {
    expect(changedRange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
    expect(changedRange('old', '')).toEqual({ from: 0, to: 3, insert: '' })
  })
})
