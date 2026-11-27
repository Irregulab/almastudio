import { describe, expect, it } from 'vitest'

import {
  findPinned, findText, joinLines, messageAt, messageFrom, normalize, sameRequest, type PinCell,
  type PinRow,
  type PinRowReader,
} from './pinnedMessages'

const COLS = 40
/** Claude Code's band behind a request, as xterm encodes an RGB colour. */
const BAND = 0x3000000 + 0x373737

/**
 * A screen from lines of text, every character one cell. A line opening with
 * `#` is on the band, all the way across as Claude Code pads it; one opening
 * with `+` goes on from the line above, wrapped by the terminal.
 */
function screen(lines: string[]): PinRowReader {
  const rows = lines.map((line): PinRow => {
    const band = line.startsWith('#')
    const wrapped = line.startsWith('+')
    const text = band || wrapped ? line.slice(1) : line
    const cells: PinCell[] = [...text].map((chars) => ({ chars, width: 1, bg: band ? BAND : -1 }))
    while (cells.length < COLS) cells.push({ chars: '', width: 1, bg: band ? BAND : -1 })
    return { cells, wrapped }
  })
  return (y) => rows[y]
}

const transcript = screen([
  '⏺ Done.', //                                          0
  '',
  '#❯ fix the login page', //                             2
  '',
  '⏺ Fixed it.', //                                       4
  '',
  '#❯ the quick brown fox jumps over the', //             6
  '#  lazy dog', //                                       7
  '#  and then', //                                       8
  '#  stops', //                                          9
  '#❯ a second one, sent right after', //                 10
  '',
  '⏺ Sure.', //                                           12
  '────────────────────────────────────────',
  '❯ typing a new one', //                           14
  '────────────────────────────────────────',
])

describe('messageAt', () => {
  it('reads a request without its sign', () => {
    expect(messageAt(transcript, 2)).toEqual({ first: 2, last: 2, text: 'fix the login page' })
  })

  it('finds the request from any of its rows, and puts its lines back together', () => {
    const message = { first: 6, last: 9, text: 'the quick brown fox jumps over the lazy dog\nand then\nstops' }
    expect(messageAt(transcript, 6)).toEqual(message)
    expect(messageAt(transcript, 8)).toEqual(message)
  })

  it('leaves out a blank row the band runs on to', () => {
    const padded = screen(['#❯ one line', '#', '⏺ ok'])
    expect(messageAt(padded, 0)).toEqual({ first: 0, last: 1, text: 'one line' })
  })

  it('keeps a request sent right after another apart from it', () => {
    expect(messageAt(transcript, 10)?.text).toBe('a second one, sent right after')
    expect(messageAt(transcript, 9)?.first).toBe(6)
  })

  it('leaves out the output around requests', () => {
    expect(messageAt(transcript, 0)).toBeNull()
    expect(messageAt(transcript, 3)).toBeNull()
    expect(messageAt(transcript, 4)).toBeNull()
  })

  it('leaves out the prompt still being typed in', () => {
    expect(messageAt(transcript, 14)).toBeNull()
  })

  it('stops at the end of the buffer', () => {
    expect(messageAt(transcript, 99)).toBeNull()
    expect(messageFrom(transcript, 99)).toBeNull()
  })
})

describe('joinLines', () => {
  it('joins lines broken at the edge with a space, and keeps the user\'s own breaks', () => {
    // 2 + 34 + 1 + 4 reaches past the edge Claude Code wraps at.
    expect(joinLines(['the quick brown fox jumps over the', 'lazy dog'], COLS)).toBe(
      'the quick brown fox jumps over the lazy dog',
    )
    expect(joinLines(['short', 'line'], COLS)).toBe('short\nline')
  })
})

describe('findPinned', () => {
  const request = (text: string) => ({ text })
  const selection = (text: string) => ({ text, selection: true })

  it('finds a request whatever width it was wrapped at', () => {
    const text = 'the quick brown fox jumps over the lazy dog\nand then\nstops'
    expect(findPinned(transcript, 0, 15, request(text))).toBe(6)
    expect(findPinned(transcript, 0, 15, request('the quick brown fox jumps over the lazy dog and then stops'))).toBe(6)
  })

  it('finds the latest of a request sent twice', () => {
    const twice = screen(['#❯ again', '⏺ ok', '#❯ again', '⏺ ok'])
    expect(findPinned(twice, 0, 3, request('again'))).toBe(2)
  })

  it('finds a request only among requests, never in other text', () => {
    // Claude Code's notice of a new version ends in "latest".
    const notice = screen(['#❯ test', '⏺ ok', 'Update available! Run: brew upgrade claude-code@latest'])
    expect(findPinned(notice, 1, 2, request('test'))).toBeNull()
    expect(findPinned(notice, 0, 2, request('test'))).toBe(0)
  })

  it('takes a short request only whole, and a long one by enough of its start', () => {
    const shorter = screen(['#❯ write me a lorem ipsum', '⏺ ok', '#❯ write me a lorem ipsum, a much longer one', '⏺ ok'])
    expect(findPinned(shorter, 0, 3, request('write me a lorem ipsum'))).toBe(0)
    expect(findPinned(shorter, 0, 3, request('write me a lorem ipsum, a much longer one'))).toBe(2)
    expect(sameRequest('write me a lorem ipsum', 'write me a lorem ipsum, a much longer one')).toBe(false)

    const long = 'a'.repeat(30) + ' ' + 'b'.repeat(30) + ' and the rest of it, which is off screen'
    expect(sameRequest(long.slice(0, 62), long)).toBe(true)
    expect(sameRequest(long.slice(0, 40), long)).toBe(false)
    // All of it on screen, when only its start was kept.
    expect(sameRequest(long, long.slice(0, 62))).toBe(true)
    expect(sameRequest(long, long.slice(0, 40))).toBe(false)
  })

  it('takes a request that is all of it before a later one that only starts the same', () => {
    const both = screen([
      '#❯ alpha bravo charlie delta echo',
      '#  foxtrot golf hotel india juliet',
      '⏺ ok',
      '#❯ alpha bravo charlie delta echo',
      '#  foxtrot golf hotel india juliet',
      '#  kilo',
      '⏺ ok',
    ])
    const first = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    expect(findPinned(both, 0, 6, request(first))).toBe(0)
    expect(findPinned(both, 0, 6, request(`${first}\nkilo`))).toBe(3)
    // Only the longer one left on screen: it is what the pin was cut from.
    expect(findPinned(both, 3, 6, request(first))).toBe(3)
  })

  it('finds a selection by its first words, across a row the terminal wrapped', () => {
    const output = screen(['$ npm run build', 'error TS2345: Argument of type str', '+ing is not assignable', '$ '])
    expect(findPinned(output, 0, 3, selection('TS2345: Argument of type string is not assignable'))).toBe(1)
    expect(findPinned(output, 0, 3, selection('npm run build'))).toBe(0)
  })

  it('finds a short selection only as words of its own', () => {
    const output = screen(['the latest build', 'a test run', 'brew upgrade claude-code@latest'])
    expect(findText(output, 0, 2, 'test')).toBe(1)
    expect(findText(output, 2, 2, 'test')).toBeNull()
  })

  it('is null for text no longer there, and for nothing', () => {
    expect(findPinned(transcript, 0, 15, request('never sent'))).toBeNull()
    expect(findPinned(transcript, 0, 15, selection('never sent'))).toBeNull()
    expect(findPinned(transcript, 0, 15, selection('  '))).toBeNull()
  })

  it('looks only between top and bottom', () => {
    expect(findPinned(transcript, 3, 15, request('fix the login page'))).toBeNull()
  })
})

describe('normalize', () => {
  it('makes any run of blanks one space', () => {
    expect(normalize('  a\n b\t\tc  ')).toBe('a b c')
  })
})
