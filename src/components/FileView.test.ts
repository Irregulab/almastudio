import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FileView } from './FileView'
import type { FileTab } from '../lib/types'

const io = vi.hoisted(() => ({
  disk: '',
  gone: false,
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
    if (io.gone) throw new Error('No such file or directory')
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
    io.gone = false
  },
  pathExists: async () => !io.gone,
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
    ConfirmDialog: ({ title, onConfirm }: { title: string; onConfirm: () => void }) =>
      h('button', { className: 'conflict', onClick: onConfirm }, title),
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
const chips = () => Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent)
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
    io.gone = false
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
    expect(chips()).not.toContain('editor.diskChanged')

    await show(false)
    io.disk = 'agent'
    await show(true)

    expect(editorText()).toBe('mine')
    expect(isDirty()).toBe(true)
    expect(chips()).toContain('editor.diskChanged')

    await click('editor.save')

    expect(document.querySelector('.conflict')).not.toBeNull()
    expect(io.writes).toEqual([])
  })

  it('catches up when edits are undone after the disk moved on', async () => {
    await type('mine')
    io.disk = 'agent'
    await act(async () => io.notify({ paths: ['/project/a.ts'], count: 1 }))
    await type('before')

    expect(editorText()).toBe('agent')
    expect(isDirty()).toBe(false)
    expect(chips()).not.toContain('editor.diskChanged')
  })

  it('clears the warning once the edits have been saved over the change', async () => {
    await type('mine')
    io.disk = 'agent'
    await act(async () => io.notify({ paths: ['/project/a.ts'], count: 1 }))
    await click('editor.save')
    await act(async () => document.querySelector<HTMLElement>('.conflict')!.click())

    expect(io.writes).toEqual(['mine'])
    expect(chips()).not.toContain('editor.diskChanged')
  })

  describe('when the file is deleted', () => {
    const remove = () => {
      io.gone = true
      return act(async () => io.notify({ paths: ['/project/a.ts'], count: 1 }))
    }

    it('keeps it on screen and says so', async () => {
      await remove()

      expect(editorText()).toBe('before')
      expect(chips()).toContain('editor.deleted')
      expect(document.querySelector('.empty')).toBeNull()
    })

    it('keeps unsaved edits, and saving them brings the file back', async () => {
      await type('mine')
      await remove()

      expect(editorText()).toBe('mine')
      expect(isDirty()).toBe(true)

      await click('editor.save')

      expect(io.writes).toEqual(['mine'])
      expect(isDirty()).toBe(false)
      expect(chips()).not.toContain('editor.deleted')
    })

    it('reverts to the last version read, as nothing is left on disk', async () => {
      await type('mine')
      await remove()
      await click('editor.revert')

      expect(editorText()).toBe('before')
      expect(isDirty()).toBe(false)
      expect(chips()).toContain('editor.deleted')
    })

    it('follows the file again when it comes back', async () => {
      await remove()
      io.gone = false
      io.disk = 'recreated'
      await act(async () => io.notify({ paths: ['/project/a.ts'], count: 1 }))

      expect(editorText()).toBe('recreated')
      expect(chips()).not.toContain('editor.deleted')
    })
  })

  describe('language chip', () => {
    const chipsFor = async (path: string) => {
      root.unmount()
      root = createRoot(document.getElementById('host')!)
      await act(async () => {
        root.render(createElement(FileView, { tab: { ...tab, path }, visible: true, focused: true }))
        await import('../lib/editorLanguage')
      })
      return chips()
    }

    it.each([
      ['a.ts', 'TypeScript'],
      ['Main.scala', 'Scala'],
      ['Cargo.toml', 'TOML'],
      ['Makefile', 'Shell'],
    ])('names the grammar colouring %s', async (path, name) => {
      expect(await chipsFor(path)).toContain(name)
    })

    it.each(['schema.graphql', 'notes.txt'])('names nothing for %s, which has none', async (path) => {
      expect(await chipsFor(path)).toHaveLength(1)
    })
  })

  it('reports a file that could not be opened at all', async () => {
    root.unmount()
    io.gone = true
    root = createRoot(document.getElementById('host')!)
    await show(true)

    expect(document.querySelector('.empty')?.textContent).toContain('No such file')
    expect(editorText()).toBeUndefined()
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

  it('saves a file with the line endings it came with', async () => {
    root.unmount()
    io.disk = 'one\r\ntwo\r\n'
    root = createRoot(document.getElementById('host')!)
    await show(true)

    await type('one!\ntwo\n')
    await click('editor.save')

    expect(io.writes).toEqual(['one!\r\ntwo\r\n'])
    expect(isDirty()).toBe(false)
  })

  it('is not dirty once an edit to a CRLF file is undone', async () => {
    root.unmount()
    io.disk = 'one\r\ntwo\r\n'
    root = createRoot(document.getElementById('host')!)
    await show(true)

    await type('one!\ntwo\n')
    expect(isDirty()).toBe(true)

    await type('one\ntwo\n')
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
