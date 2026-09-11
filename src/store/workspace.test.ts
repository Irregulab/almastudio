import { beforeEach, describe, expect, it } from 'vitest'
import { migrateWorkspace, useWorkspace } from './workspace'
import { allTabIds, findLeafOfTab } from '../lib/layout'
import type { Project, TerminalTab } from '../lib/types'

const project = (name: string): Project => ({
  id: `p-${name}`,
  name,
  icon: '',
  color: '#000000',
  root: `/tmp/${name}`,
  instructions: '',
  defaultHarness: 'default',
  createdAt: 0,
  lastOpenedAt: 0,
})

const order = () => useWorkspace.getState().projects.map((p) => p.name)

describe('reorderProjects', () => {
  beforeEach(() => {
    useWorkspace.setState({ projects: ['a', 'b', 'c', 'd'].map(project), loaded: true })
  })

  it('moves an item forward, compensating for its own removal', () => {
    // "Put a before c" — the index refers to the order as it looks now.
    useWorkspace.getState().reorderProjects(0, 2)
    expect(order()).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves an item backward', () => {
    useWorkspace.getState().reorderProjects(3, 1)
    expect(order()).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves an item to the end', () => {
    useWorkspace.getState().reorderProjects(0, 4)
    expect(order()).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves an item to the front', () => {
    useWorkspace.getState().reorderProjects(2, 0)
    expect(order()).toEqual(['c', 'a', 'b', 'd'])
  })

  it('is a no-op when the drop lands where the item already is', () => {
    // Dropping just before or just after itself changes nothing.
    useWorkspace.getState().reorderProjects(1, 1)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
    useWorkspace.getState().reorderProjects(1, 2)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  // The sidebar's Move up / Move down items call reorderProjects with i-1 and
  // i+2; these lock that arithmetic in against the "insert before" semantics.
  it('supports move-up as reorder(i, i - 1)', () => {
    useWorkspace.getState().reorderProjects(2, 1)
    expect(order()).toEqual(['a', 'c', 'b', 'd'])
  })

  it('supports move-down as reorder(i, i + 2)', () => {
    useWorkspace.getState().reorderProjects(1, 3)
    expect(order()).toEqual(['a', 'c', 'b', 'd'])
  })

  it('ignores an out-of-range source', () => {
    useWorkspace.getState().reorderProjects(9, 0)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
    useWorkspace.getState().reorderProjects(-1, 2)
    expect(order()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never loses or duplicates a project', () => {
    for (const [from, to] of [[0, 3], [2, 0], [3, 1], [1, 4], [0, 1]]) {
      useWorkspace.getState().reorderProjects(from, to)
      expect([...order()].sort()).toEqual(['a', 'b', 'c', 'd'])
    }
  })
})

describe('tabs and splits', () => {
  const pid = 'p-x'
  const store = () => useWorkspace.getState()
  const ws = () => store().workspaces[pid]
  const sessionsByTab = () => ws().groups.map((g) => allTabIds(g.layout))
  const open = (kind: TerminalTab['kind'] = 'shell', cwd = '/tmp/x') =>
    store().addTerminalTab({ projectId: pid, kind, cwd })
  const paneOf = (tabId: string) => {
    for (const g of ws().groups) {
      const leaf = findLeafOfTab(g.layout, tabId)
      if (leaf) return leaf.id
    }
    throw new Error(`no pane shows ${tabId}`)
  }
  const groupOf = (tabId: string) =>
    ws().groups.find((g) => allTabIds(g.layout).includes(tabId))!

  beforeEach(() => {
    useWorkspace.setState({
      projects: [project('x')],
      tabs: {},
      workspaces: {},
      activeProjectId: pid,
      loaded: true,
    })
  })

  it('opens each new session as a tab of its own, in front', () => {
    const a = open()
    const b = open()
    expect(sessionsByTab()).toEqual([[a.id], [b.id]])
    expect(ws().activeGroupId).toBe(groupOf(b.id).id)
  })

  it('splits only the tab it was asked to, with the same kind of session in the same folder', () => {
    const a = open('shell')
    const b = open('claude', '/tmp/x/api')
    store().splitPane(paneOf(b.id), 'row')

    const [first, second] = sessionsByTab()
    expect(first).toEqual([a.id])
    expect(second).toHaveLength(2)
    const added = store().tabs[second[1]] as TerminalTab
    expect(added.kind).toBe('claude')
    expect(added.cwd).toBe('/tmp/x/api')
    // The new pane takes focus, inside the tab that was split.
    const group = groupOf(b.id)
    expect(ws().activeGroupId).toBe(group.id)
    expect(group.activePaneId).toBe(paneOf(added.id))
  })

  it('keeps a tab when one of its panes closes', () => {
    const a = open()
    store().splitPane(paneOf(a.id), 'col')
    const added = sessionsByTab()[0][1]
    store().closeTab(added)
    expect(sessionsByTab()).toEqual([[a.id]])
    expect(groupOf(a.id).activePaneId).toBe(paneOf(a.id))
  })

  it('removes a tab with its last pane and brings its neighbour forward', () => {
    const a = open()
    const b = open()
    const c = open()
    store().setActiveGroup(groupOf(b.id).id)
    store().closeTab(b.id)
    expect(sessionsByTab()).toEqual([[a.id], [c.id]])
    expect(ws().activeGroupId).toBe(groupOf(c.id).id)
  })

  it('closes every pane of a tab at once', () => {
    const a = open()
    store().splitPane(paneOf(a.id), 'row')
    const b = open()
    store().closeGroup(groupOf(a.id).id)
    expect(sessionsByTab()).toEqual([[b.id]])
    expect(Object.keys(store().tabs)).toEqual([b.id])
  })

  it('drops a tab beside a pane of another tab, closing the tab it left', () => {
    const a = open()
    const b = open()
    store().dropGroupIntoSplit(groupOf(b.id).id, paneOf(a.id), 'row', false)
    expect(sessionsByTab()).toEqual([[a.id, b.id]])
    expect(ws().activeGroupId).toBe(groupOf(a.id).id)
  })

  it('ignores a tab dropped onto its own pane', () => {
    const a = open()
    const before = ws()
    store().dropGroupIntoSplit(groupOf(a.id).id, paneOf(a.id), 'row', false)
    expect(ws()).toBe(before)
  })

  it('moves a pane out into a tab of its own', () => {
    const a = open()
    store().splitPane(paneOf(a.id), 'row')
    const added = sessionsByTab()[0][1]
    store().movePaneToNewGroup(paneOf(added))
    expect(sessionsByTab()).toEqual([[a.id], [added]])
    expect(ws().activeGroupId).toBe(groupOf(added).id)
  })

  it('reorders tabs with insert-before semantics', () => {
    const a = open()
    const b = open()
    const c = open()
    store().moveGroup(0, 3)
    expect(sessionsByTab()).toEqual([[b.id], [c.id], [a.id]])
  })
})

describe('migrateWorkspace', () => {
  const panel = { open: false, view: 'changes' as const, width: 380, pinnedRoot: null }

  it('turns every session of a version-1 layout into a tab, keeping the one in front', () => {
    const v1 = {
      layout: {
        type: 'split',
        id: 's',
        dir: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', id: 'L1', tabIds: ['t1', 't2'], activeTabId: 't2' },
          { type: 'leaf', id: 'L2', tabIds: ['t3'], activeTabId: 't3' },
        ],
      },
      activePaneId: 'L1',
      panel,
    }
    const ws = migrateWorkspace(v1, () => true)

    expect(ws.groups.map((g) => allTabIds(g.layout))).toEqual([['t1'], ['t2'], ['t3']])
    const front = ws.groups.find((g) => g.id === ws.activeGroupId)!
    expect(allTabIds(front.layout)).toEqual(['t2'])
    expect(ws.panel).toEqual(panel)
  })

  it('drops panes whose session no longer exists', () => {
    const v1 = {
      layout: { type: 'leaf', id: 'L1', tabIds: ['gone', 'kept'], activeTabId: 'gone' },
      activePaneId: 'L1',
      panel,
    }
    const ws = migrateWorkspace(v1, (id) => id === 'kept')
    expect(ws.groups.map((g) => allTabIds(g.layout))).toEqual([['kept']])
    expect(ws.activeGroupId).toBe(ws.groups[0].id)
  })

  it('leaves a current workspace as it is', () => {
    const current = migrateWorkspace(
      { layout: { type: 'leaf', id: 'L1', tabIds: ['t1'], activeTabId: 't1' }, activePaneId: 'L1', panel },
      () => true,
    )
    expect(migrateWorkspace(current, () => true)).toEqual(current)
  })
})

describe('categories and pinned repositories', () => {
  beforeEach(() => {
    useWorkspace.setState({
      projects: ['a', 'b', 'c'].map(project),
      collapsedCategories: [],
      loaded: true,
    })
  })

  const byName = (name: string) => useWorkspace.getState().projects.find((p) => p.name === name)!

  it('files a project dropped among another category’s projects under that category', () => {
    useWorkspace.getState().updateProject('p-c', { category: 'Work' })
    useWorkspace.getState().reorderProjects(0, 2, 'Work')
    expect(order()).toEqual(['b', 'a', 'c'])
    expect(byName('a').category).toBe('Work')
  })

  it('takes a project out of its category when dropped among ones without', () => {
    useWorkspace.getState().updateProject('p-a', { category: 'Work' })
    useWorkspace.getState().reorderProjects(0, 3, '')
    expect(order()).toEqual(['b', 'c', 'a'])
    expect(byName('a').category).toBeUndefined()
  })

  it('changes the category even where the position stays the same', () => {
    useWorkspace.getState().reorderProjects(1, 1, 'Home')
    expect(order()).toEqual(['a', 'b', 'c'])
    expect(byName('b').category).toBe('Home')
  })

  it('leaves the category alone when the drop names none', () => {
    useWorkspace.getState().updateProject('p-a', { category: 'Work' })
    useWorkspace.getState().reorderProjects(0, 3)
    expect(byName('a').category).toBe('Work')
  })

  it('folds and unfolds a category', () => {
    useWorkspace.getState().toggleCategory('Work')
    expect(useWorkspace.getState().collapsedCategories).toEqual(['Work'])
    useWorkspace.getState().toggleCategory('Work')
    expect(useWorkspace.getState().collapsedCategories).toEqual([])
  })

  it('pins and unpins repositories for one project only', () => {
    const ws = useWorkspace.getState()
    ws.togglePinnedRepo('p-a', '/tmp/a/api')
    ws.togglePinnedRepo('p-a', '/tmp/a/web')
    expect(byName('a').pinnedRepos).toEqual(['/tmp/a/api', '/tmp/a/web'])
    expect(byName('b').pinnedRepos).toBeUndefined()
    useWorkspace.getState().togglePinnedRepo('p-a', '/tmp/a/api')
    expect(byName('a').pinnedRepos).toEqual(['/tmp/a/web'])
  })
})
