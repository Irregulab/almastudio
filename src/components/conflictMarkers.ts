import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

import { findConflicts, resolvedLines, type Resolution } from '../lib/conflicts'

export interface ConflictLabels {
  current: string
  incoming: string
  both: string
}

/** Replaces the document's `index`th conflict with the side, or sides, chosen. */
function resolve(view: EditorView, index: number, choice: Resolution) {
  const doc = view.state.doc
  const text = doc.toString()
  const conflict = findConflicts(text)[index]
  if (!conflict) return
  const kept = resolvedLines(text.split('\n'), conflict, choice)
  const last = doc.line(conflict.end + 1)
  const followed = last.number < doc.lines
  view.dispatch({
    changes: {
      from: doc.line(conflict.start + 1).from,
      to: followed ? last.to + 1 : last.to,
      insert: kept.length > 0 ? kept.join('\n') + (followed ? '\n' : '') : '',
    },
  })
}

/** "Accept Current Change | Accept Incoming Change | Accept Both Changes", as VS Code puts it. */
class ConflictActions extends WidgetType {
  constructor(readonly index: number, readonly labels: ConflictLabels) {
    super()
  }

  eq(other: ConflictActions) {
    return other.index === this.index && other.labels === this.labels
  }

  toDOM(view: EditorView) {
    const bar = document.createElement('div')
    bar.className = 'cm-conflict-actions'
    const choices: Array<[Resolution, string]> = [
      ['current', this.labels.current],
      ['incoming', this.labels.incoming],
      ['both', this.labels.both],
    ]
    for (const [choice, label] of choices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      // Leave the editor's selection where it was.
      button.addEventListener('mousedown', (e) => e.preventDefault())
      button.addEventListener('click', () => resolve(view, this.index, choice))
      bar.append(button)
    }
    return bar
  }

  ignoreEvent() {
    return true
  }
}

function decorate(state: EditorState, labels: ConflictLabels): DecorationSet {
  const doc = state.doc
  const ranges: Range<Decoration>[] = []
  findConflicts(doc.toString()).forEach((conflict, index) => {
    const at = (line: number) => doc.line(line + 1).from
    ranges.push(
      Decoration.widget({ widget: new ConflictActions(index, labels), side: -1, block: true })
        .range(at(conflict.start)),
    )
    for (let line = conflict.start; line <= conflict.end; line++) {
      const isMarker = [conflict.start, conflict.base, conflict.separator, conflict.end].includes(line)
      const part = isMarker
        ? 'marker'
        : line < (conflict.base ?? conflict.separator)
          ? 'current'
          : line > conflict.separator ? 'incoming' : 'base'
      ranges.push(Decoration.line({ class: `cm-conflict-${part}` }).range(at(line)))
    }
  })
  return Decoration.set(ranges, true)
}

/**
 * Marks the conflicts a merge left in a file, the current side and the
 * incoming one each in its own colour, with buttons above each to keep
 * either or both. A block widget has to come from a state field.
 */
export function conflictMarkers(labels: ConflictLabels): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => decorate(state, labels),
    update: (decorations, tr) => (tr.docChanged ? decorate(tr.state, labels) : decorations),
    provide: (field) => EditorView.decorations.from(field),
  })
}
