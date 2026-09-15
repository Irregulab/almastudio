/** A merge conflict in a file's text, by 0-based line number. */
export interface Conflict {
  /** The `<<<<<<<` line. */
  start: number
  /** The `|||||||` line, when the merge left the common ancestor in (diff3). */
  base: number | null
  /** The `=======` line. */
  separator: number
  /** The `>>>>>>>` line. */
  end: number
  /** What the markers call each side, e.g. "HEAD" and a branch. */
  currentLabel: string
  incomingLabel: string
}

export type Resolution = 'current' | 'incoming' | 'both'

const marker = (line: string, char: string) => {
  const clean = line.replace(/\r$/, '')
  return clean.startsWith(char.repeat(7)) && (clean.length === 7 || clean[7] === ' ')
    ? clean.slice(7).trim()
    : null
}

/** The conflicts git left in a file, in order; unfinished ones are ignored. */
export function findConflicts(text: string): Conflict[] {
  const lines = text.split('\n')
  const found: Conflict[] = []
  let open: { start: number; label: string; base: number | null; separator: number | null } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = marker(line, '<')
    if (start !== null) {
      open = { start: i, label: start, base: null, separator: null }
      continue
    }
    if (!open) continue
    if (open.separator === null && marker(line, '|') !== null) {
      open.base = i
    } else if (open.separator === null && line.replace(/\r$/, '') === '=======') {
      open.separator = i
    } else if (open.separator !== null) {
      const end = marker(line, '>')
      if (end === null) continue
      found.push({
        start: open.start,
        base: open.base,
        separator: open.separator,
        end: i,
        currentLabel: open.label,
        incomingLabel: end,
      })
      open = null
    }
  }
  return found
}

/** The lines a conflict is replaced with for a choice. */
export function resolvedLines(lines: string[], conflict: Conflict, choice: Resolution): string[] {
  const current = lines.slice(conflict.start + 1, conflict.base ?? conflict.separator)
  const incoming = lines.slice(conflict.separator + 1, conflict.end)
  if (choice === 'current') return current
  if (choice === 'incoming') return incoming
  return [...current, ...incoming]
}

/** The text with one conflict replaced by the side, or sides, chosen. */
export function resolveConflict(text: string, conflict: Conflict, choice: Resolution): string {
  const lines = text.split('\n')
  return [
    ...lines.slice(0, conflict.start),
    ...resolvedLines(lines, conflict, choice),
    ...lines.slice(conflict.end + 1),
  ].join('\n')
}
