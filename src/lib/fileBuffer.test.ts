import { describe, expect, it } from 'vitest'

import { followDisk } from './fileBuffer'

describe('followDisk', () => {
  it('fills an empty tab on the first read', () => {
    expect(followDisk({ content: '', original: '' }, 'file')).toEqual({ content: 'file', original: 'file' })
  })

  it('follows the file when there are no edits', () => {
    const buffer = { content: 'old', original: 'old' }
    expect(followDisk(buffer, 'new')).toEqual({ content: 'new', original: 'new' })
  })

  it('keeps edits and the base they started from when the file moves on', () => {
    const buffer = { content: 'mine', original: 'old' }
    expect(followDisk(buffer, 'agent')).toEqual(buffer)
  })

  it('treats a tab emptied on purpose as an edit', () => {
    const buffer = { content: '', original: 'old' }
    expect(followDisk(buffer, 'old')).toEqual(buffer)
  })

  it('is clean again once the disk matches the edits', () => {
    expect(followDisk({ content: 'saved', original: 'old' }, 'saved')).toEqual({
      content: 'saved',
      original: 'saved',
    })
  })

  it('takes the disk when asked to discard edits', () => {
    const buffer = { content: 'mine', original: 'old' }
    expect(followDisk(buffer, 'agent', true)).toEqual({ content: 'agent', original: 'agent' })
  })
})
