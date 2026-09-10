import { useDrag } from '../lib/dragDrop'

/** The label that follows the pointer while a tab or project is dragged. */
export function DragPreview() {
  const label = useDrag((s) => s.item?.label ?? null)
  const x = useDrag((s) => s.x)
  const y = useDrag((s) => s.y)
  if (label === null) return null
  return (
    <div
      className="drag-preview truncate"
      style={{ transform: `translate(${x + 14}px, ${y + 10}px)` }}
      aria-hidden
    >
      {label}
    </div>
  )
}
