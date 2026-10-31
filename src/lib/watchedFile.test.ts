import { describe, expect, it } from 'vitest'

import { parentDir, touchesFile } from './watchedFile'

describe('parentDir', () => {
  it('finds the folder on either kind of path', () => {
    expect(parentDir('/project/src/a.ts')).toBe('/project/src')
    expect(parentDir('C:\\project\\a.ts')).toBe('C:\\project')
    expect(parentDir('C:\\project/src/a.ts')).toBe('C:\\project/src')
  })

  it('keeps the root', () => {
    expect(parentDir('/a.ts')).toBe('/')
  })
})

describe('touchesFile', () => {
  const change = (paths: string[], count = paths.length) => ({ paths, count })

  it('matches the file and nothing else in its folder', () => {
    expect(touchesFile(change(['/project/a.ts']), '/project/a.ts')).toBe(true)
    expect(touchesFile(change(['/project/ab.ts']), '/project/a.ts')).toBe(false)
  })

  it('matches through a symlinked folder', () => {
    expect(touchesFile(change(['/private/tmp/a.ts']), '/tmp/a.ts')).toBe(true)
  })

  it('assumes a match when the list was cut short', () => {
    expect(touchesFile(change(['/project/b.ts'], 41), '/project/a.ts')).toBe(true)
  })
})
