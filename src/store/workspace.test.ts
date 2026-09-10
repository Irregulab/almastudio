import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspace } from './workspace'
import type { Project } from '../lib/types'

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
