import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'
import type { FileTab } from '../lib/types'

const io = vi.hoisted(() => ({
  disk: '',
  large: false,
  reads: 0,
  writes: [] as string[],
  type: (_text: string) => {},
  save: () => {},
  watch: true,
  wrap: false,
  watched: [] as Array<[string, boolean]>,
  notify: (_change: { paths: string[]; count: number }) => {},
}))

vi.mock('../lib/ipc', () => ({
  readTextFile: async (path: string) => {
    io.reads++
    return {
      path,
      content: io.large ? '' : io.disk,
      size: io.disk.length,
      binary: false,
      truncated: io.large,
    }
  },
  readTextHead: async (path: string) => ({
    path, content: io.disk.slice(0, 5), size: io.disk.length, binary: false, truncated: true,
  }),
  writeTextFile: async (_path: string, content: string) => {
    io.writes.push(content)
    io.disk = content
  },
  allowPreview: async () => {},
  gitMarkResolved: async () => {},
  onFsChange: async (_id: string, cb: typeof io.notify) => {
    io.notify = cb
    return () => {}
  },
  watchStart: async (_id: string, path: string, recursive: boolean) => {
    io.watched.push([path, recursive])
  },
  watchStop: async () => {},
}))
vi.mock('../hooks/useAutoFetch', () => ({ GIT_CHANGED_EVENT: 'git-changed' }))
vi.mock('../store/settings', () => ({
  useSettings: (pick: (s: unknown) => unknown) =>
    pick({
      settings: { panel: { watch: io.watch }, editor: { wordWrap: io.wrap } },
      patch: (_key: string, value: { wordWrap: boolean }) => {
        io.wrap = value.wordWrap
      },
    }),
}))
vi.mock('../store/ui', () => ({
  useUi: (pick: (s: unknown) => unknown) => pick({ setTabDirty: () => {} }),
}))
vi.mock('../store/workspace', () => ({
  useWorkspace: (pick: (s: unknown) => unknown) => pick({ pinTab: () => {} }),
}))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./ui', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmDialog: ({ title }: { title: string }) => h('div', { className: 'conflict' }, title),
    Segmented: () => null,
  }
})
vi.mock('./CodeEditor', async () => {
  const { createElement: h } = await import('react')
  return {
    CodeEditor: ({ value, onChange, onSave, readOnly, wordWrap }: {
      value: string
      onChange: (text: string) => void
      onSave: () => void
      readOnly?: boolean
      wordWrap?: boolean
    }) => {
      io.type = onChange
      io.save = onSave
      return h('pre', {
        className: 'stub-editor',
        'data-wrap': String(!!wordWrap),
        'data-readonly': String(!!readOnly),
      }, value)
    },
  }
})
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (src: string) => src }))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: async () => {},
  revealItemInDir: async () => {},
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tab = { id: 'tab', kind: 'file', root: '/project', path: 'a.ts' } as FileTab

const editorText = () => document.querySelector('.stub-editor')?.textContent
const isDirty = () => !!document.querySelector('.diff__dirty')
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!

describe('FileView', () => {
  let root: Root
  const show = (visible: boolean) =>
    act(async () => root.render(createElement(FileView, { tab, visible, focused: visible })))
  const click = (label: string) => act(async () => button(label).click())
  const type = (text: string) => act(async () => io.type(text))

  beforeEach(async () => {
    io.disk = 'before'
    io.large = false
    io.reads = 0
    io.writes = []
    io.watch = true
    io.wrap = false
    io.watched = []
    document.body.innerHTML = '<div id="host"></div>'
    root = createRoot(document.getElementById('host')!)
    await show(true)
  })

  it('shows what an agent wrote while the tab was behind another', async () => {
    await show(false)
    io.disk = 'agent'
    await show(true)

    expect(editorText()).toBe('agent')
    expect(isDirty()).toBe(false)
  })

  it('keeps unsaved edits and asks before saving over what an agent wrote', async () => {
    await type('mine')
    await show(false)
    io.disk = 'agent'
    await show(true)

    expect(editorText()).toBe('mine')
    expect(isDirty()).toBe(true)

    await click('editor.save')

    expect(document.querySelector('.conflict')).not.toBeNull()
    expect(io.writes).toEqual([])
  })

  it('reverts to what is on disk, not to the text the edits started from', async () => {
    await type('mine')
    await show(false)
    io.disk = 'agent'
    await show(true)
    await click('editor.revert')

    expect(editorText()).toBe('agent')
    expect(isDirty()).toBe(false)
  })

  it('follows the file while it is on screen, watching only its folder', async () => {
    expect(io.watched).toEqual([['/project', false]])

    io.disk = 'agent'
    await act(async () => io.notify({ paths: ['/project/a.ts'], count: 1 }))

    expect(editorText()).toBe('agent')
    expect(isDirty()).toBe(false)
  })

  it('ignores changes to other files in the folder', async () => {
    const reads = io.reads
    await act(async () => io.notify({ paths: ['/project/b.ts'], count: 1 }))

    expect(io.reads).toBe(reads)
  })

  it('does not watch when watching is turned off', async () => {
    root.unmount()
    io.watch = false
    io.watched = []
    root = createRoot(document.getElementById('host')!)
    await show(true)

    expect(io.watched).toEqual([])
  })

  it('toggles word wrap and hands it to the editor', async () => {
    const wrapped = () => document.querySelector('.stub-editor')?.getAttribute('data-wrap')
    expect(wrapped()).toBe('false')

    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="editor.wordWrap"]')!.click(),
    )
    await show(true)

    expect(io.wrap).toBe(true)
    expect(wrapped()).toBe('true')
  })

  it('shows the start of a file too large to load, and never writes it back', async () => {
    root.unmount()
    io.disk = 'first second'
    io.large = true
    root = createRoot(document.getElementById('host')!)
    await show(true)

    const editor = document.querySelector('.stub-editor')
    expect(editor?.textContent).toBe('first')
    expect(editor?.getAttribute('data-readonly')).toBe('true')
    expect(button('editor.save')).toBeUndefined()

    await act(async () => io.save())
    expect(io.writes).toEqual([])
  })

  it('leaves an ordinary file editable', () => {
    expect(document.querySelector('.stub-editor')?.getAttribute('data-readonly')).toBe('false')
  })

  it('saves without asking when the file has not moved', async () => {
    await type('mine')
    await click('editor.save')

    expect(document.querySelector('.conflict')).toBeNull()
    expect(io.writes).toEqual(['mine'])
    expect(isDirty()).toBe(false)
  })
})
