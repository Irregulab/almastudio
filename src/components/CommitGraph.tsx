import { useMemo } from 'react'
import { Tag } from 'lucide-react'

import { layoutGraph, type GraphRow, type GraphSegment } from '../lib/commitGraph'
import { relativeTime } from '../lib/time'
import type { GraphCommit } from '../lib/types'

/** Row height and the width of one lane, in pixels. */
export const ROW = 22
export const LANE = 12
/** Beyond this many lanes the graph is clipped rather than crowding the text. */
export const MAX_LANES = 10
/** The id of the row standing for uncommitted changes, drawn above HEAD. */
export const UNCOMMITTED = '*uncommitted*'
/** Lanes cycle through these colours. */
const COLORS = ['var(--accent)', 'var(--green)', 'var(--purple)', 'var(--yellow)', 'var(--red)']

const colorOf = (index: number) => COLORS[index % COLORS.length]
const x = (lane: number) => LANE / 2 + lane * LANE

function pathOf({ kind, from, to }: GraphSegment): string {
  const [x1, x2] = [x(from), x(to)]
  const mid = ROW / 2
  switch (kind) {
    case 'through':
      return `M${x1} 0V${ROW}`
    case 'in':
      return x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.8} ${x2} ${mid * 0.2} ${x2} ${mid}`
    case 'out':
      return x1 === x2
        ? `M${x1} ${mid}V${ROW}`
        : `M${x1} ${mid}C${x1} ${mid * 1.8} ${x2} ${mid * 1.2} ${x2} ${ROW}`
  }
}

/** One row's lanes: the lines passing through it and the commit's dot. */
export function GraphLanes({ row, lanes }: { row: GraphRow; lanes: number }) {
  const { commit, lane, color, segments } = row
  const uncommitted = commit.id === UNCOMMITTED
  // A merge, and the changes not yet committed, get a ring instead of a dot.
  const ring = uncommitted || commit.parents.length > 1
  return (
    <svg className="graph__lanes" width={lanes * LANE} height={ROW} aria-hidden>
      {segments.map((s, i) => (
        <path
          key={i} d={pathOf(s)} stroke={colorOf(s.color)}
          strokeDasharray={uncommitted && s.kind === 'out' ? '2 2' : undefined}
        />
      ))}
      <circle
        className={ring ? 'graph__hole' : undefined}
        cx={x(lane)} cy={ROW / 2} r={ring ? 3 : 3.5}
        fill={ring ? undefined : colorOf(color)}
        stroke={colorOf(color)} strokeWidth={ring ? 2 : 0}
        strokeDasharray={uncommitted ? '2 1.5' : undefined}
      />
    </svg>
  )
}

/**
 * The commit graph: the history of every branch, each line of work in a lane
 * of its own, merges drawn where they join, and branches and tags labelled on
 * the commits they point at.
 */
export function CommitGraph({
  commits, selected, onSelect,
}: {
  commits: GraphCommit[]
  selected?: string | null
  onSelect?: (commit: GraphCommit) => void
}) {
  const rows = useMemo(() => layoutGraph(commits), [commits])
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)))

  return (
    <ul className="graph">
      {rows.map((row) => {
        const { commit } = row
        const date = new Date(commit.time * 1000).toLocaleString()
        return (
          <li
            key={commit.id}
            className={`graph__row${selected === commit.id ? ' is-selected' : ''}`}
            title={`${commit.shortId} · ${commit.author} <${commit.email}> · ${date}\n\n${commit.summary}`}
            onClick={() => onSelect?.(commit)}
          >
            <GraphLanes row={row} lanes={lanes} />
            {commit.refs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.name}`}
                className={`graph__ref graph__ref--${ref.kind}${ref.current ? ' graph__ref--current' : ''}`}
              >
                {ref.kind === 'tag' && <Tag size={9} />}
                {ref.name}
              </span>
            ))}
            <span className="graph__summary truncate">{commit.summary}</span>
            <span className="graph__time subtle">{relativeTime(commit.time)}</span>
          </li>
        )
      })}
    </ul>
  )
}
