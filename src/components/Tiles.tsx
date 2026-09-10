import { Fragment, useRef } from 'react'
import { useWorkspace } from '../store/workspace'
import { isSplit } from '../lib/layout'
import type { LayoutNode, SplitNode, TabGroup } from '../lib/types'
import { Pane } from './Pane'

const MIN_FRACTION = 0.12

/** One tab's tiling tree. `visible` is whether that tab is the one in front. */
export function TileNode({
  node, group, visible,
}: { node: LayoutNode; group: TabGroup; visible: boolean }) {
  return isSplit(node) ? (
    <Split node={node} group={group} visible={visible} />
  ) : (
    <Pane leaf={node} group={group} visible={visible} />
  )
}

function Split({ node, group, visible }: { node: SplitNode; group: TabGroup; visible: boolean }) {
  const resizeSplit = useWorkspace((s) => s.resizeSplit)
  const hostRef = useRef<HTMLDivElement>(null)

  /**
   * Sizes are written straight to the DOM while dragging and committed to the
   * store only on release. Re-rendering the tree on every pointer move would
   * make every terminal in it re-fit sixty times a second.
   */
  const startDrag = (index: number) => (e: React.PointerEvent) => {
    const host = hostRef.current
    if (!host) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)

    const horizontal = node.dir === 'row'
    const rect = host.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const sizes = [...node.sizes]
    const startPos = horizontal ? e.clientX : e.clientY
    const a = sizes[index]
    const b = sizes[index + 1]
    const children = Array.from(host.children).filter((c) =>
      c.classList.contains('tile'),
    ) as HTMLElement[]

    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - startPos) / total
      const clamped = Math.max(
        -(a - MIN_FRACTION),
        Math.min(delta, b - MIN_FRACTION),
      )
      sizes[index] = a + clamped
      sizes[index + 1] = b - clamped
      children.forEach((el, i) => {
        el.style.flexBasis = `${sizes[i] * 100}%`
      })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      ;(e.target as Element).releasePointerCapture?.(ev.pointerId)
      resizeSplit(node.id, sizes)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={hostRef} className={`split split--${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="tile"
            style={{ flexBasis: `${(node.sizes[i] ?? 1 / node.children.length) * 100}%` }}
          >
            <TileNode node={child} group={group} visible={visible} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`divider divider--${node.dir}`}
              onPointerDown={startDrag(i)}
              role="separator"
              aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}
