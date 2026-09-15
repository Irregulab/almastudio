import type { GraphCommit } from './types'

/** A line in one row of the graph, between lanes. */
export interface GraphSegment {
  /**
   * `in` runs from the top of the row to the commit, `out` from the commit to
   * the bottom, and `through` passes the row by on its lane.
   */
  kind: 'in' | 'out' | 'through'
  from: number
  to: number
  /** Index into the lane colours. */
  color: number
}

export interface GraphRow {
  commit: GraphCommit
  /** The lane the commit's dot sits in. */
  lane: number
  color: number
  segments: GraphSegment[]
  /** Lanes this row draws in. */
  width: number
}

/**
 * Lays out a commit graph the way `git log --graph` does. Each lane holds the
 * commit expected next on it. A commit takes the lane expecting it — lanes
 * that also expect it, branches forked from it, end there — or a new lane
 * when none does, as for a branch tip. Its first parent carries on in its
 * lane; another parent, a merged branch, gets a lane of its own unless one
 * already expects it.
 *
 * Commits must come children first, as `git_graph` lists them.
 */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  const open = (id: string) => {
    let i = lanes.indexOf(null)
    if (i < 0) i = lanes.push(id) - 1
    else lanes[i] = id
    colors[i] = nextColor++
    return i
  }

  return commits.map((commit) => {
    const segments: GraphSegment[] = []
    let lane = lanes.indexOf(commit.id)
    lanes.forEach((id, i) => {
      if (id === null) return
      segments.push(
        id === commit.id
          ? { kind: 'in', from: i, to: lane, color: colors[i] }
          : { kind: 'through', from: i, to: i, color: colors[i] },
      )
    })
    if (lane < 0) lane = open(commit.id)
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.id) lanes[i] = null
    }

    const color = colors[lane]
    const [first, ...others] = commit.parents
    lanes[lane] = first ?? null
    if (first !== undefined) segments.push({ kind: 'out', from: lane, to: lane, color })
    for (const parent of others) {
      const waiting = lanes.indexOf(parent)
      const target = waiting >= 0 ? waiting : open(parent)
      segments.push({ kind: 'out', from: lane, to: target, color: colors[target] })
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }
    const width = Math.max(lane, ...segments.flatMap((s) => [s.from, s.to])) + 1
    return { commit, lane, color, segments, width }
  })
}

/** Whether a commit matches a search: its subject, author, hash or a ref's name. */
export function matchesCommit(commit: GraphCommit, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return (
    commit.summary.toLowerCase().includes(q) ||
    commit.author.toLowerCase().includes(q) ||
    commit.email.toLowerCase().includes(q) ||
    commit.id.startsWith(q) ||
    commit.refs.some((ref) => ref.name.toLowerCase().includes(q))
  )
}
