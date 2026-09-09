import { describe, expect, it } from 'vitest'
import {
  allLeaves, findLeaf, findLeafOfTab, makeLeaf, moveTab, normalize,
  removeLeaf, removeTab, resizeSplit, splitLeaf,
} from './layout'
import type { LayoutNode, SplitNode } from './types'

const leafWith = (...tabs: string[]) => makeLeaf(tabs)

describe('splitLeaf', () => {
  it('wraps a leaf in a split containing both panes', () => {
    const a = leafWith('t1')
    const b = leafWith('t2')
    const root = splitLeaf(a, a.id, 'row', b) as SplitNode

    expect(root.type).toBe('split')
    expect(root.dir).toBe('row')
    expect(root.children.map((c) => c.id)).toEqual([a.id, b.id])
    expect(root.sizes).toEqual([0.5, 0.5])
  })

  it('extends an existing row instead of nesting another one', () => {
    const a = leafWith('t1')
    const b = leafWith('t2')
    const c = leafWith('t3')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'row', c)

    // Three panes side by side, not a split inside a split.
    expect(root.type).toBe('split')
    const split = root as SplitNode
    expect(split.children).toHaveLength(3)
    expect(split.children.every((ch) => ch.type === 'leaf')).toBe(true)
    expect(split.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
  })

  it('nests when the direction differs', () => {
    const a = leafWith('t1')
    const b = leafWith('t2')
    const c = leafWith('t3')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'col', c) as SplitNode

    const split = root as SplitNode
    expect(split.dir).toBe('row')
    expect(split.children).toHaveLength(2)
    expect(split.children[1].type).toBe('split')
  })
})

describe('normalize', () => {
  it('collapses a split with a single child', () => {
    const leaf = leafWith('t1')
    const split: SplitNode = {
      type: 'split', id: 's', dir: 'row', sizes: [1], children: [leaf],
    }
    expect(normalize(split)).toEqual(leaf)
  })

  it('rescales absorbed children so sizes still sum to one', () => {
    const a = leafWith('a')
    const b = leafWith('b')
    const c = leafWith('c')
    const inner: SplitNode = {
      type: 'split', id: 'inner', dir: 'row', sizes: [0.5, 0.5], children: [b, c],
    }
    const outer: SplitNode = {
      type: 'split', id: 'outer', dir: 'row', sizes: [0.6, 0.4], children: [a, inner],
    }
    const flat = normalize(outer) as SplitNode

    expect(flat.children.map((ch) => ch.id)).toEqual([a.id, b.id, c.id])
    expect(flat.sizes[0]).toBeCloseTo(0.6)
    expect(flat.sizes[1]).toBeCloseTo(0.2)
    expect(flat.sizes[2]).toBeCloseTo(0.2)
    expect(flat.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
  })
})

describe('removeTab', () => {
  it('activates the neighbour when the active tab goes away', () => {
    const leaf = leafWith('t1', 't2', 't3')
    const withActive: LayoutNode = { ...leaf, activeTabId: 't2' }
    const { root } = removeTab(withActive, 't2')

    const next = findLeaf(root!, leaf.id)!
    expect(next.tabIds).toEqual(['t1', 't3'])
    expect(next.activeTabId).toBe('t3')
  })

  it('activates the previous tab when the last one is removed', () => {
    const leaf: LayoutNode = { ...leafWith('t1', 't2'), activeTabId: 't2' }
    const { root } = removeTab(leaf, 't2')
    expect(findLeaf(root!, leaf.id)!.activeTabId).toBe('t1')
  })

  it('leaves the active tab alone when another one is removed', () => {
    const leaf: LayoutNode = { ...leafWith('t1', 't2', 't3'), activeTabId: 't3' }
    const { root } = removeTab(leaf, 't1')
    expect(findLeaf(root!, leaf.id)!.activeTabId).toBe('t3')
  })

  it('keeps the last pane alive but empty', () => {
    const leaf = leafWith('t1')
    const { root, removedPaneId } = removeTab(leaf, 't1')

    expect(removedPaneId).toBeNull()
    expect(allLeaves(root!)).toHaveLength(1)
    expect(allLeaves(root!)[0].tabIds).toEqual([])
    expect(allLeaves(root!)[0].activeTabId).toBeNull()
  })

  it('collapses an emptied pane when siblings remain', () => {
    const a = leafWith('t1')
    const b = leafWith('t2')
    const root = splitLeaf(a, a.id, 'row', b)
    const { root: next, removedPaneId } = removeTab(root, 't2')

    expect(removedPaneId).toBe(b.id)
    // The split degenerates back to the surviving leaf.
    expect(next!.type).toBe('leaf')
    expect(allLeaves(next!)[0].tabIds).toEqual(['t1'])
  })
})

describe('moveTab', () => {
  it('reorders within the same pane', () => {
    const leaf = leafWith('t1', 't2', 't3')
    const root = moveTab(leaf, 't3', leaf.id, 0)
    expect(findLeaf(root, leaf.id)!.tabIds).toEqual(['t3', 't1', 't2'])
  })

  it('moves between panes and focuses the tab in its new home', () => {
    const a = leafWith('t1', 't2')
    const b = leafWith('t3')
    const root = splitLeaf(a, a.id, 'row', b)
    const next = moveTab(root, 't1', b.id, 0)

    expect(findLeaf(next, a.id)!.tabIds).toEqual(['t2'])
    const target = findLeaf(next, b.id)!
    expect(target.tabIds).toEqual(['t1', 't3'])
    expect(target.activeTabId).toBe('t1')
  })

  it('refuses a move that would collapse the target pane away', () => {
    const a = leafWith('t1')
    const b = leafWith('t2')
    const root = splitLeaf(a, a.id, 'row', b)
    // Emptying `a` removes it; `b` survives, so this move is fine.
    const ok = moveTab(root, 't1', b.id, 0)
    expect(findLeafOfTab(ok, 't1')!.id).toBe(b.id)

    // Moving a pane's only tab into itself is a no-op, not a collapse.
    const same = moveTab(a, 't1', a.id, 0)
    expect(findLeaf(same, a.id)!.tabIds).toEqual(['t1'])
  })
})

describe('removeLeaf', () => {
  it('returns null when the last pane is removed', () => {
    const a = leafWith('t1')
    expect(removeLeaf(a, a.id)).toBeNull()
  })

  it('redistributes sizes across the survivors', () => {
    const a = leafWith('a')
    const b = leafWith('b')
    const c = leafWith('c')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'row', c)
    const next = removeLeaf(root, b.id) as SplitNode

    expect(next.children).toHaveLength(2)
    expect(next.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
  })
})

describe('resizeSplit', () => {
  it('normalises the fractions it is given', () => {
    const a = leafWith('a')
    const b = leafWith('b')
    const root = splitLeaf(a, a.id, 'row', b) as SplitNode
    const next = resizeSplit(root, root.id, [3, 1]) as SplitNode

    expect(next.sizes[0]).toBeCloseTo(0.75)
    expect(next.sizes[1]).toBeCloseTo(0.25)
  })
})
