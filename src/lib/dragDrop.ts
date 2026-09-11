import type { PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'

import { useWorkspace } from '../store/workspace'

/**
 * Pointer-driven drag and drop for tabs and projects.
 *
 * HTML5 drag and drop cannot be used here. A file dragged in from Finder only
 * reaches the app with its real path through the native drop handler, and
 * that handler intercepts every drag over the webview — the app's own
 * included — so WebKit would never deliver dragover or drop. Tracking the
 * pointer directly sidesteps the conflict on every platform.
 *
 * Drop targets are ordinary elements carrying `data-drop-*` attributes. This
 * module hit-tests them under the pointer and publishes the would-be target;
 * components only read it to draw their indicators.
 */

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

export type DragItem =
  /** A tab from the strip; `id` is its group. */
  | { kind: 'tab'; id: string; label: string }
  | { kind: 'project'; id: string; index: number; label: string }

export type DropTarget =
  /** Between two chips of the tab strip; `index` is the insertion point. */
  | { kind: 'tab-slot'; index: number }
  /** Over a pane: an edge puts the tab's focused session beside it; the centre does nothing. */
  | { kind: 'pane'; paneId: string; zone: DropZone }
  /**
   * Between two rows of the project list. `category` is the section the slot
   * is in when the list is grouped ('' for projects without one): a project
   * dropped there joins it.
   */
  | { kind: 'project-slot'; index: number; category?: string }

interface DragState {
  item: DragItem | null
  target: DropTarget | null
  /** Pointer position, for the preview that follows it. */
  x: number
  y: number
  /** Terminal tab that a file dragged in from outside would be dropped into. */
  fileDropTab: string | null
}

export const useDrag = create<DragState>(() => ({
  item: null,
  target: null,
  x: 0,
  y: 0,
  fileDropTab: null,
}))

type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

/** Which drop a pointer position over a pane means. */
export function zoneAt(x: number, y: number, rect: Rect): DropZone {
  const EDGE = 0.22
  const left = (x - rect.left) / rect.width
  const top = (y - rect.top) / rect.height
  const distances: Array<[DropZone, number]> = [
    ['left', left],
    ['right', 1 - left],
    ['top', top],
    ['bottom', 1 - top],
  ]
  const [zone, nearest] = distances.reduce((a, b) => (b[1] < a[1] ? b : a))
  return nearest > EDGE ? 'center' : zone
}

function targetAt(item: DragItem, x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)
  if (!el) return null

  if (item.kind === 'project') {
    const row = el.closest<HTMLElement>('[data-drop-project]')
    if (row) {
      const r = row.getBoundingClientRect()
      const index = Number(row.dataset.index) + (y < r.top + r.height / 2 ? 0 : 1)
      return { kind: 'project-slot', index, category: row.dataset.category }
    }
    // A category's header means the end of that category, folded or not.
    const header = el.closest<HTMLElement>('[data-drop-project-section]')
    if (header) {
      return {
        kind: 'project-slot',
        index: Number(header.dataset.index),
        category: header.dataset.category,
      }
    }
    // The empty space below the rows means "put it last".
    const list = el.closest<HTMLElement>('[data-drop-project-list]')
    return list ? { kind: 'project-slot', index: Number(list.dataset.count) } : null
  }

  const chip = el.closest<HTMLElement>('[data-drop-tab-chip]')
  if (chip) {
    const r = chip.getBoundingClientRect()
    const index = Number(chip.dataset.index) + (x < r.left + r.width / 2 ? 0 : 1)
    return { kind: 'tab-slot', index }
  }
  const bar = el.closest<HTMLElement>('[data-drop-tabbar]')
  if (bar) return { kind: 'tab-slot', index: Number(bar.dataset.count) }
  const pane = el.closest<HTMLElement>('[data-drop-pane]')
  if (pane) {
    return {
      kind: 'pane',
      paneId: pane.dataset.paneId!,
      zone: zoneAt(x, y, pane.getBoundingClientRect()),
    }
  }
  return null
}

function commit(item: DragItem, target: DropTarget) {
  const ws = useWorkspace.getState()
  if (item.kind === 'project') {
    if (target.kind === 'project-slot') {
      ws.reorderProjects(item.index, target.index, target.category)
    }
    return
  }
  if (target.kind === 'tab-slot') {
    const groups = ws.activeProjectId ? ws.workspaces[ws.activeProjectId]?.groups : undefined
    const from = groups?.findIndex((g) => g.id === item.id) ?? -1
    if (from >= 0) ws.moveGroup(from, target.index)
  } else if (target.kind === 'pane' && target.zone !== 'center') {
    const dir = target.zone === 'left' || target.zone === 'right' ? 'row' : 'col'
    ws.dropGroupIntoSplit(item.id, target.paneId, dir, target.zone === 'left' || target.zone === 'top')
  }
}

/** The release that ends a drag still produces a click; it must not select. */
function swallowNextClick() {
  const stop = (ev: MouseEvent) => {
    ev.stopPropagation()
    ev.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  // A release over nothing clickable produces no click to swallow.
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
}

/** Pixels the pointer must travel before a press becomes a drag. */
const THRESHOLD = 4

/**
 * Pointer-down handler for a drag source. The press only turns into a drag
 * once the pointer has moved a few pixels, so a plain click still selects.
 * Escape, losing focus or a cancelled pointer abandon the drag.
 */
export function beginPointerDrag(e: ReactPointerEvent, item: DragItem) {
  if (e.button !== 0) return
  // Controls inside the source — a tab's close button, the rename field —
  // keep their own behaviour.
  const control = (e.target as Element).closest('button, input, textarea, a')
  if (control && control !== e.currentTarget) return

  const startX = e.clientX
  const startY = e.clientY
  let dragging = false

  const onMove = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return
      dragging = true
      document.documentElement.classList.add('is-dragging')
      useDrag.setState({ item })
    }
    useDrag.setState({
      x: ev.clientX,
      y: ev.clientY,
      target: targetAt(item, ev.clientX, ev.clientY),
    })
  }

  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('blur', onCancel)
    window.removeEventListener('keydown', onKey, true)
    if (!dragging) return
    const { target } = useDrag.getState()
    useDrag.setState({ item: null, target: null })
    document.documentElement.classList.remove('is-dragging')
    swallowNextClick()
    if (drop && target) commit(item, target)
  }
  const onUp = () => finish(true)
  const onCancel = () => finish(false)
  const onKey = (ev: KeyboardEvent) => {
    if (!dragging || ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    finish(false)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('blur', onCancel)
  window.addEventListener('keydown', onKey, true)
}
