import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'
import type { FileTab } from '../lib/types'

const io = vi.hoisted(() => ({
  disk: '',
  writes: [] as string[],
  type: (_text: string) => {},
}))

vi.mock('../lib/ipc', () => ({
  readTextFile: async (path: string) => ({
    path, content: io.disk, size: io.disk.length, binary: false, truncated: false,
  }),
  writeTextFile: async (_path: string, content: string) => {
    io.writes.push(content)
    io.disk = content
  },
  allowPreview: async () => {},
  gitMarkResolved: async () => {},
}))
vi.mock('../hooks/useAutoFetch', () => ({ GIT_CHANGED_EVENT: 'git-changed' }))
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
    io.writes = []
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

  it('saves without asking when the file has not moved', async () => {
    await type('mine')
    await click('editor.save')

    expect(document.querySelector('.conflict')).toBeNull()
    expect(io.writes).toEqual(['mine'])
    expect(isDirty()).toBe(false)
  })
})
