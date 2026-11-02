import { describe, expect, it } from 'vitest'

import { findChoice } from './choice'

describe('findChoice', () => {
  it('reads a permission prompt', () => {
    const screen = [
      '⏺ Bash(rm -rf dist)',
      '╭──────────────────────────────────────────╮',
      '│ Do you want to proceed?                  │',
      '│ ❯ 1. Yes                                 │',
      "│   2. Yes, and don't ask again for rm     │",
      '│   3. No, and tell Claude what to do      │',
      '╰──────────────────────────────────────────╯',
    ]
    expect(findChoice(screen)).toEqual({
      options: ['Yes', "Yes, and don't ask again for rm", 'No, and tell Claude what to do'],
      selected: 0,
    })
  })

  it('follows the pointer and skips wrapped descriptions', () => {
    const screen = [
      'Which database?',
      '  1. Postgres',
      '     The relational one',
      '› 2. SQLite',
      '     A file on disk',
      '  3. Redis',
      '',
      'Enter to select · Esc to cancel',
    ]
    expect(findChoice(screen)).toEqual({ options: ['Postgres', 'SQLite', 'Redis'], selected: 1 })
  })

  it('ignores numbered text with nothing pointed at', () => {
    expect(findChoice(['Steps:', '1. build', '2. test', '3. ship', '$ '])).toBeNull()
  })

  it('needs more than one option', () => {
    expect(findChoice(['❯ 1. only'])).toBeNull()
  })

  it('takes the menu nearest the bottom', () => {
    const screen = ['❯ 1. old', '  2. older', 'output', '', '', '', '', 'New?', '  1. a', '❯ 2. b']
    expect(findChoice(screen)).toEqual({ options: ['a', 'b'], selected: 1 })
  })
})
