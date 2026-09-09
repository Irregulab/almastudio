/** Immutable operations on the tiling tree.
 *
 * The tree alternates between splits (row/col with fractional sizes) and
 * leaves (a pane holding an ordered list of tabs). Every operation returns a
 * new tree, then `normalize` collapses the degenerate shapes those operations
 * can produce — one-child splits and nested splits sharing a direction — so
 * the tree never accumulates invisible structure over a long session. */

import type { LayoutNode, LeafNode, SplitNode } from './types'
import { uid } from './id'

export const makeLeaf = (tabIds: string[] = [], activeTabId: string | null = null): LeafNode => ({
  type: 'leaf',
  id: uid('pane'),
  tabIds,
  activeTabId: activeTabId ?? tabIds[0] ?? null,
})

export const isLeaf = (n: LayoutNode): n is LeafNode => n.type === 'leaf'
export const isSplit = (n: LayoutNode): n is SplitNode => n.type === 'split'

export function allLeaves(node: LayoutNode): LeafNode[] {
  return isLeaf(node) ? [node] : node.children.flatMap(allLeaves)
}

export function findLeaf(node: LayoutNode, id: string): LeafNode | null {
  if (isLeaf(node)) return node.id === id ? node : null
  for (const c of node.children) {
    const hit = findLeaf(c, id)
    if (hit) return hit
  }
  return null
}

export function findLeafOfTab(node: LayoutNode, tabId: string): LeafNode | null {
  return allLeaves(node).find((l) => l.tabIds.includes(tabId)) ?? null
}

export function allTabIds(node: LayoutNode): string[] {
  return allLeaves(node).flatMap((l) => l.tabIds)
}

/** Replaces one leaf in place, leaving the rest of the tree untouched. */
export function updateLeaf(
  node: LayoutNode,
  id: string,
  fn: (leaf: LeafNode) => LeafNode,
): LayoutNode {
  if (isLeaf(node)) return node.id === id ? fn(node) : node
  return { ...node, children: node.children.map((c) => updateLeaf(c, id, fn)) }
}

/** Flattens one-child splits and merges nested splits of the same direction. */
export function normalize(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node

  const children: LayoutNode[] = []
  const sizes: number[] = []

  node.children.forEach((child, i) => {
    const n = normalize(child)
    const size = node.sizes[i] ?? 1 / node.children.length
    if (isSplit(n) && n.dir === node.dir) {
      // Absorb the nested split's children, scaling their shares into ours.
      n.children.forEach((gc, j) => {
        children.push(gc)
        sizes.push(size * (n.sizes[j] ?? 1 / n.children.length))
      })
    } else {
      children.push(n)
      sizes.push(size)
    }
  })

  if (children.length === 1) return children[0]

  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { ...node, children, sizes: sizes.map((s) => s / total) }
}

/**
 * Splits `leafId`, placing `newLeaf` after it. The result is normalized, so
 * splitting right inside an existing row extends that row rather than nesting.
 */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  dir: 'row' | 'col',
  newLeaf: LeafNode,
): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (node.id !== leafId) return node
      const split: SplitNode = {
        type: 'split',
        id: uid('split'),
        dir,
        sizes: [0.5, 0.5],
        children: [node, newLeaf],
      }
      return split
    }
    return { ...node, children: node.children.map(replace) }
  }
  return normalize(replace(root))
}

/** Removes a pane. Returns null when it was the last one. */
export function removeLeaf(root: LayoutNode, leafId: string): LayoutNode | null {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (isLeaf(node)) return node.id === leafId ? null : node

    const kept: LayoutNode[] = []
    const sizes: number[] = []
    node.children.forEach((c, i) => {
      const n = walk(c)
      if (n) {
        kept.push(n)
        sizes.push(node.sizes[i] ?? 1 / node.children.length)
      }
    })
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0]
    const total = sizes.reduce((a, b) => a + b, 0) || 1
    return { ...node, children: kept, sizes: sizes.map((s) => s / total) }
  }
  const next = walk(root)
  return next ? normalize(next) : null
}

/** Removes a tab from whichever pane holds it, dropping the pane if it empties. */
export function removeTab(
  root: LayoutNode,
  tabId: string,
): { root: LayoutNode | null; removedPaneId: string | null } {
  const leaf = findLeafOfTab(root, tabId)
  if (!leaf) return { root, removedPaneId: null }

  const remaining = leaf.tabIds.filter((id) => id !== tabId)
  if (remaining.length === 0) {
    // Never dissolve the last pane — an empty workspace still needs somewhere
    // for the next tab to land.
    if (allLeaves(root).length === 1) {
      return {
        root: updateLeaf(root, leaf.id, (l) => ({ ...l, tabIds: [], activeTabId: null })),
        removedPaneId: null,
      }
    }
    return { root: removeLeaf(root, leaf.id), removedPaneId: leaf.id }
  }

  const wasActive = leaf.activeTabId === tabId
  const idx = leaf.tabIds.indexOf(tabId)
  const nextActive = wasActive
    ? remaining[Math.min(idx, remaining.length - 1)]
    : leaf.activeTabId
  return {
    root: updateLeaf(root, leaf.id, (l) => ({ ...l, tabIds: remaining, activeTabId: nextActive })),
    removedPaneId: null,
  }
}

/** Moves a tab into `targetPaneId` at `index`, collapsing an emptied source. */
export function moveTab(
  root: LayoutNode,
  tabId: string,
  targetPaneId: string,
  index: number,
): LayoutNode {
  const source = findLeafOfTab(root, tabId)
  if (!source) return root

  if (source.id === targetPaneId) {
    const without = source.tabIds.filter((id) => id !== tabId)
    const at = Math.max(0, Math.min(index, without.length))
    without.splice(at, 0, tabId)
    return updateLeaf(root, source.id, (l) => ({ ...l, tabIds: without, activeTabId: tabId }))
  }

  const detached = removeTab(root, tabId)
  let next = detached.root
  if (!next) return root
  // The target pane may have been collapsed away with the emptied source.
  if (!findLeaf(next, targetPaneId)) return root

  next = updateLeaf(next, targetPaneId, (l) => {
    const ids = [...l.tabIds]
    const at = Math.max(0, Math.min(index, ids.length))
    ids.splice(at, 0, tabId)
    return { ...l, tabIds: ids, activeTabId: tabId }
  })
  return normalize(next)
}

/** Applies new fractional sizes to one split. */
export function resizeSplit(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) return node
    if (node.id === splitId) {
      const total = sizes.reduce((a, b) => a + b, 0) || 1
      return { ...node, sizes: sizes.map((s) => s / total) }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/** Pane order as rendered, used by "next / previous pane" navigation. */
export function paneOrder(root: LayoutNode): string[] {
  return allLeaves(root).map((l) => l.id)
}
