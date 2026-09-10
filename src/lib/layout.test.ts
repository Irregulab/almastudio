import { describe, expect, it } from 'vitest'
import {
  allLeaves, allTabIds, containsNode, findLeafOfTab, firstPaneId, makeLeaf, normalize,
  removeLeaf, resizeSplit, splitLeaf,
} from './layout'
import type { SplitNode } from './types'

describe('splitLeaf', () => {
  it('wraps a leaf in a split containing both panes', () => {
    const a = makeLeaf('t1')
    const b = makeLeaf('t2')
    const root = splitLeaf(a, a.id, 'row', b) as SplitNode

    expect(root.type).toBe('split')
    expect(root.dir).toBe('row')
    expect(root.children.map((c) => c.id)).toEqual([a.id, b.id])
    expect(root.sizes).toEqual([0.5, 0.5])
  })

  it('extends an existing row instead of nesting another one', () => {
    const a = makeLeaf('t1')
    const b = makeLeaf('t2')
    const c = makeLeaf('t3')
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
    const a = makeLeaf('t1')
    const b = makeLeaf('t2')
    const c = makeLeaf('t3')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'col', c) as SplitNode

    const split = root as SplitNode
    expect(split.dir).toBe('row')
    expect(split.children).toHaveLength(2)
    expect(split.children[1].type).toBe('split')
  })
})

describe('splitLeaf before', () => {
  it('places the new pane first when asked', () => {
    const a = makeLeaf('t1')
    const b = makeLeaf('t2')
    const root = splitLeaf(a, a.id, 'row', b, true) as SplitNode
    expect(root.children.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('still extends a same-direction row rather than nesting', () => {
    const a = makeLeaf('a')
    const b = makeLeaf('b')
    const c = makeLeaf('c')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, a.id, 'row', c, true)
    const split = root as SplitNode
    expect(split.type).toBe('split')
    expect(split.children.map((ch) => ch.id)).toEqual([c.id, a.id, b.id])
    expect(split.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
  })
})

describe('normalize', () => {
  it('collapses a split with a single child', () => {
    const leaf = makeLeaf('t1')
    const split: SplitNode = {
      type: 'split', id: 's', dir: 'row', sizes: [1], children: [leaf],
    }
    expect(normalize(split)).toEqual(leaf)
  })

  it('rescales absorbed children so sizes still sum to one', () => {
    const a = makeLeaf('a')
    const b = makeLeaf('b')
    const c = makeLeaf('c')
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

describe('finding panes and sessions', () => {
  const tree = () => {
    const a = makeLeaf('a')
    const b = makeLeaf('b')
    const c = makeLeaf('c')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'col', c)
    return { a, b, c, root }
  }

  it('finds the pane showing a session anywhere in the tree', () => {
    const { c, root } = tree()
    expect(findLeafOfTab(root, 'c')!.id).toBe(c.id)
    expect(findLeafOfTab(root, 'nope')).toBeNull()
  })

  it('lists sessions in rendering order and starts from the first pane', () => {
    const { a, root } = tree()
    expect(allTabIds(root)).toEqual(['a', 'b', 'c'])
    expect(firstPaneId(root)).toBe(a.id)
  })

  it('knows which splits and panes a tree contains', () => {
    const { c, root } = tree()
    expect(containsNode(root, root.id)).toBe(true)
    expect(containsNode(root, c.id)).toBe(true)
    expect(containsNode(root, 'elsewhere')).toBe(false)
  })
})

describe('removeLeaf', () => {
  it('returns null when the last pane is removed', () => {
    const a = makeLeaf('t1')
    expect(removeLeaf(a, a.id)).toBeNull()
  })

  it('collapses the split when one pane is left', () => {
    const a = makeLeaf('t1')
    const b = makeLeaf('t2')
    const next = removeLeaf(splitLeaf(a, a.id, 'row', b), b.id)!
    expect(next).toEqual(a)
    expect(allLeaves(next)).toHaveLength(1)
  })

  it('redistributes sizes across the survivors', () => {
    const a = makeLeaf('a')
    const b = makeLeaf('b')
    const c = makeLeaf('c')
    let root = splitLeaf(a, a.id, 'row', b)
    root = splitLeaf(root, b.id, 'row', c)
    const next = removeLeaf(root, b.id) as SplitNode

    expect(next.children).toHaveLength(2)
    expect(next.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
  })
})

describe('resizeSplit', () => {
  it('normalises the fractions it is given', () => {
    const a = makeLeaf('a')
    const b = makeLeaf('b')
    const root = splitLeaf(a, a.id, 'row', b) as SplitNode
    const next = resizeSplit(root, root.id, [3, 1]) as SplitNode

    expect(next.sizes[0]).toBeCloseTo(0.75)
    expect(next.sizes[1]).toBeCloseTo(0.25)
  })
})
