/** Word-level diff between a removed and an added line.
 *
 * git gives us line-granularity hunks; pairing adjacent -/+ lines and marking
 * only the words that actually changed is what makes a diff readable when a
 * long line had one identifier renamed. */

export interface Segment {
  text: string
  changed: boolean
}

const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? []

/** Longest common subsequence over tokens, then walked back into segments. */
export function wordDiff(oldLine: string, newLine: string): {
  removed: Segment[]
  added: Segment[]
} {
  const a = tokenize(oldLine)
  const b = tokenize(newLine)

  // Guard against the quadratic table on pathological lines (minified files).
  if (a.length * b.length > 40_000) {
    return {
      removed: [{ text: oldLine, changed: true }],
      added: [{ text: newLine, changed: true }],
    }
  }

  const m = a.length
  const n = b.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const removed: Segment[] = []
  const added: Segment[] = []
  const push = (arr: Segment[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1]
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }

  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(removed, a[i], false)
      push(added, b[j], false)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(removed, a[i++], true)
    } else {
      push(added, b[j++], true)
    }
  }
  while (i < m) push(removed, a[i++], true)
  while (j < n) push(added, b[j++], true)

  return { removed, added }
}

/** Pairs each removed line with the added line replacing it inside one hunk. */
export function pairChangedLines<T extends { origin: string }>(
  lines: T[],
): Map<number, number> {
  const pairs = new Map<number, number>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].origin !== '-') {
      i++
      continue
    }
    let dels = 0
    while (i + dels < lines.length && lines[i + dels].origin === '-') dels++
    let adds = 0
    while (i + dels + adds < lines.length && lines[i + dels + adds].origin === '+') adds++
    // Only pair balanced runs; a 3-for-1 replacement has no sensible pairing.
    if (dels === adds) {
      for (let k = 0; k < dels; k++) pairs.set(i + k, i + dels + k)
    }
    i += dels + adds || 1
  }
  return pairs
}
