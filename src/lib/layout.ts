/** Immutable operations on the tiling tree inside a tab.
 *
 * The tree alternates between splits (row/col with fractional sizes) and
 * leaves (a pane showing one session). Every operation returns a new tree,
 * then `normalize` collapses the degenerate shapes those operations can
 * produce — one-child splits and nested splits sharing a direction — so the
 * tree never accumulates invisible structure over a long session. */

import type { LayoutNode, LeafNode, SplitNode } from './types'
import { uid } from './id'

export const makeLeaf = (tabId: string): LeafNode => ({ type: 'leaf', id: uid('pane'), tabId })

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
  return allLeaves(node).find((l) => l.tabId === tabId) ?? null
}

/** The sessions a tree shows, in rendering order. */
export function allTabIds(node: LayoutNode): string[] {
  return allLeaves(node).map((l) => l.tabId)
}

/** True when `id` names a split or a pane anywhere in the tree. */
export function containsNode(node: LayoutNode, id: string): boolean {
  return node.id === id || (isSplit(node) && node.children.some((c) => containsNode(c, id)))
}

/** Shows `tabId` in pane `leafId`, in place of the session it showed. */
export function setLeafTab(node: LayoutNode, leafId: string, tabId: string): LayoutNode {
  if (isLeaf(node)) return node.id === leafId ? { ...node, tabId } : node
  return { ...node, children: node.children.map((c) => setLeafTab(c, leafId, tabId)) }
}

/** The first pane in rendering order. */
export const firstPaneId = (node: LayoutNode): string =>
  isLeaf(node) ? node.id : firstPaneId(node.children[0])

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
 * Splits `leafId`, placing `newLeaf` after it — or before it when `before` is
 * set, which is what a drop on the left or top edge of a pane means. The
 * result is normalized, so splitting right inside an existing row extends that
 * row rather than nesting.
 */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  dir: 'row' | 'col',
  newLeaf: LeafNode,
  before = false,
): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (node.id !== leafId) return node
      const split: SplitNode = {
        type: 'split',
        id: uid('split'),
        dir,
        sizes: [0.5, 0.5],
        children: before ? [newLeaf, node] : [node, newLeaf],
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
