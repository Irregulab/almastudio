import { useMemo } from 'react'
import { Tag } from 'lucide-react'

import { layoutGraph, type GraphSegment } from '../lib/commitGraph'
import { relativeTime } from '../lib/time'
import type { GraphCommit } from '../lib/types'

/** Row height and the width of one lane, in pixels. */
const ROW = 22
const LANE = 12
/** Beyond this many lanes the graph is clipped rather than crowding the text. */
const MAX_LANES = 10
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

/**
 * The commit graph: the history of every branch, each line of work in a lane
 * of its own, merges drawn where they join, and branches and tags labelled on
 * the commits they point at.
 */
export function CommitGraph({ commits }: { commits: GraphCommit[] }) {
  const rows = useMemo(() => layoutGraph(commits), [commits])
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)))

  return (
    <ul className="graph">
      {rows.map(({ commit, lane, color, segments }) => {
        const merge = commit.parents.length > 1
        const date = new Date(commit.time * 1000).toLocaleString()
        return (
          <li
            key={commit.id}
            className="graph__row"
            title={`${commit.shortId} · ${commit.author} <${commit.email}> · ${date}\n\n${commit.summary}`}
          >
            <svg className="graph__lanes" width={lanes * LANE} height={ROW} aria-hidden>
              {segments.map((s, i) => (
                <path key={i} d={pathOf(s)} stroke={colorOf(s.color)} />
              ))}
              <circle
                cx={x(lane)} cy={ROW / 2} r={merge ? 3 : 3.5}
                fill={merge ? 'var(--bg-panel)' : colorOf(color)}
                stroke={colorOf(color)} strokeWidth={merge ? 2 : 0}
              />
            </svg>
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
