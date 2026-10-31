/**
 * The one stretch of `from` that has to be replaced to get `to`.
 *
 * An editor keeps its scroll position and cursor through a change that leaves
 * them alone, which replacing the whole document never does.
 */
export function changedRange(from: string, to: string) {
  const shared = Math.min(from.length, to.length)
  let start = 0
  while (start < shared && from.charCodeAt(start) === to.charCodeAt(start)) start++

  let fromEnd = from.length
  let toEnd = to.length
  while (fromEnd > start && toEnd > start && from.charCodeAt(fromEnd - 1) === to.charCodeAt(toEnd - 1)) {
    fromEnd--
    toEnd--
  }
  return { from: start, to: fromEnd, insert: to.slice(start, toEnd) }
}
