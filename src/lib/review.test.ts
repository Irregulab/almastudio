import { describe, expect, it } from 'vitest'

import { anchorLines, diffSignature, formatReview } from './review'
import type { DiffLine, FileDiff } from './types'

const line = (origin: string, oldLineno: number | null, newLineno: number | null, content: string): DiffLine =>
  ({ origin, oldLineno, newLineno, content })

const diffOf = (lines: DiffLine[]): FileDiff => ({
  path: 'a.ts', oldPath: null, binary: false, truncated: false, additions: 1, deletions: 1,
  status: 'modified',
  hunks: [{ header: '@@', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines }],
})

describe('anchorLines', () => {
  it('counts a run in the file its last line belongs to', () => {
    const run = [line('-', 4, null, 'old'), line('+', null, 4, 'new'), line(' ', 5, 5, 'same')]
    expect(anchorLines(run)).toEqual({
      side: 'new', startLine: 4, line: 5, code: '-old\n+new\n same',
    })
  })

  it('anchors a removed line in the old file', () => {
    expect(anchorLines([line('-', 7, null, 'gone')])).toMatchObject({ side: 'old', startLine: 7, line: 7 })
  })
})

describe('diffSignature', () => {
  it('changes with the content, and only then', () => {
    const lines = [line('-', 1, null, 'a'), line('+', null, 1, 'b')]
    expect(diffSignature(diffOf(lines))).toBe(diffSignature(diffOf([...lines])))
    expect(diffSignature(diffOf(lines))).not.toBe(
      diffSignature(diffOf([lines[0], line('+', null, 1, 'c')])),
    )
  })
})

describe('formatReview', () => {
  it('lists comments by file and line under the general one', () => {
    const text = formatReview({
      general: ' Overall fine. ',
      viewed: {},
      comments: [
        { id: '2', path: 'b.ts', side: 'old', startLine: 9, line: 9, code: '-x', kind: 'question', body: 'Why?' },
        { id: '1', path: 'a.ts', side: 'new', startLine: 3, line: 5, code: '+y', kind: 'fix', body: 'Rename it.' },
      ],
    })
    expect(text).toContain('## General comment\nOverall fine.')
    expect(text).toContain('### a.ts:3-5 [fix]\n````diff\n+y\n````\nRename it.')
    expect(text).toContain('### b.ts:9 (removed line) [question]')
    expect(text.indexOf('a.ts:3-5')).toBeLessThan(text.indexOf('b.ts:9'))
    // The instructions name the kinds as the comments are tagged.
    expect(text.split('\n')[0]).toContain('[question]')
  })
})
