import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'
import type { FileTab } from '../lib/types'

const io = vi.hoisted(() => ({
  disk: '',
  reads: 0,
  writes: [] as string[],
  type: (_text: string) => {},
  watch: true,
  watched: [] as Array<[string, boolean]>,
  notify: (_change: { paths: string[]; count: number }) => {},
}))

vi.mock('../lib/ipc', () => ({
  readTextFile: async (path: string) => {
    io.reads++
    return { path, content: io.disk, size: io.disk.length, binary: false, truncated: false }
  },
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
  useSettings: (pick: (s: unknown) => unknown) => pick({ settings: { panel: { watch: io.watch } } }),
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
    CodeEditor: ({ value, onChange }: { value: string; onChange: (text: string) => void }) => {
      io.type = onChange
      return h('pre', { className: 'stub-editor' }, value)
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
    io.reads = 0
    io.writes = []
    io.watch = true
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

  it('saves without asking when the file has not moved', async () => {
    await type('mine')
    await click('editor.save')

    expect(document.querySelector('.conflict')).toBeNull()
    expect(io.writes).toEqual(['mine'])
    expect(isDirty()).toBe(false)
  })
})
