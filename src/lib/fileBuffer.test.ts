import { describe, expect, it } from 'vitest'

import { applyEdit, followDisk } from './fileBuffer'

describe('applyEdit', () => {
  const edit = (original: string, text: string) => applyEdit({ content: original, original }, text)

  it('leaves text alone in a file that uses LF', () => {
    expect(edit('one\ntwo\n', 'one!\ntwo\n').content).toBe('one!\ntwo\n')
  })

  it('gives every line back the CRLF of its file', () => {
    expect(edit('one\r\ntwo\r\n', 'one!\ntwo\nnew\n').content).toBe('one!\r\ntwo\r\nnew\r\n')
  })

  it('is clean again when an edit is undone', () => {
    const buffer = edit('one\r\ntwo\r\n', 'one\ntwo\n')
    expect(buffer.content).toBe(buffer.original)
  })

  it('gives a file that mixes them the one it mostly uses', () => {
    expect(edit('a\r\nb\r\nc\n', 'a\nb\nc\n').content).toBe('a\r\nb\r\nc\r\n')
    expect(edit('a\r\nb\nc\n', 'a\nb\nc\n').content).toBe('a\nb\nc\n')
  })

  it('uses LF for a file with no line ends yet', () => {
    expect(edit('', 'a\nb').content).toBe('a\nb')
    expect(edit('one line', 'one\nline').content).toBe('one\nline')
  })

  it('keeps the base', () => {
    expect(edit('a\r\n', 'b\n').original).toBe('a\r\n')
  })
})

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
