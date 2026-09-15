import { describe, expect, it } from 'vitest'
import { findConflicts, resolveConflict } from './conflicts'

const text = [
  'keep', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs', '>>>>>>> feature', 'after',
].join('\n')

describe('findConflicts', () => {
  it('finds a conflict with its markers and labels', () => {
    expect(findConflicts(text)).toEqual([
      { start: 1, base: null, separator: 4, end: 6, currentLabel: 'HEAD', incomingLabel: 'feature' },
    ])
  })

  it('notes the common ancestor of a diff3 conflict', () => {
    const diff3 = ['<<<<<<< ours', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> theirs'].join('\n')
    expect(findConflicts(diff3)[0]).toMatchObject({ start: 0, base: 2, separator: 4, end: 6 })
  })

  it('reads CRLF files and ignores lookalikes and unfinished conflicts', () => {
    expect(findConflicts('x\r\n<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> t\r\n')).toHaveLength(1)
    expect(findConflicts('a\n=======\nb\n<<<<<<<< not a marker\n>>>>>>> t')).toEqual([])
    expect(findConflicts('<<<<<<< HEAD\na\n=======\nb')).toEqual([])
  })

  it('finds every conflict in a file', () => {
    expect(findConflicts(`${text}\n${text}`).map((c) => c.start)).toEqual([1, 9])
  })
})

describe('resolveConflict', () => {
  const [conflict] = findConflicts(text)

  it('keeps the side chosen, or both, and drops the markers', () => {
    expect(resolveConflict(text, conflict, 'current')).toBe('keep\nours 1\nours 2\nafter')
    expect(resolveConflict(text, conflict, 'incoming')).toBe('keep\ntheirs\nafter')
    expect(resolveConflict(text, conflict, 'both')).toBe('keep\nours 1\nours 2\ntheirs\nafter')
  })

  it('leaves the ancestor of a diff3 conflict out of the current side', () => {
    const diff3 = ['<<<<<<< ours', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> theirs'].join('\n')
    const [c] = findConflicts(diff3)
    expect(resolveConflict(diff3, c, 'current')).toBe('a')
    expect(resolveConflict(diff3, c, 'both')).toBe('a\nb')
  })
})
