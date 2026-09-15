import { describe, expect, it } from 'vitest'
import { layoutGraph } from './commitGraph'
import type { GraphCommit } from './types'

const commit = (id: string, ...parents: string[]): GraphCommit => ({
  id,
  shortId: id,
  parents,
  summary: id,
  author: '',
  email: '',
  time: 0,
  refs: [],
})

/** Each row as "commit@lane: segments", e.g. "M@0: out0-0 out0-1". */
const shape = (commits: GraphCommit[]) =>
  layoutGraph(commits).map(
    (r) => `${r.commit.id}@${r.lane}: ${r.segments.map((s) => `${s.kind}${s.from}-${s.to}`).join(' ')}`,
  )

describe('layoutGraph', () => {
  it('keeps a straight history in one lane', () => {
    expect(shape([commit('c', 'b'), commit('b', 'a'), commit('a')])).toEqual([
      'c@0: out0-0',
      'b@0: in0-0 out0-0',
      'a@0: in0-0',
    ])
  })

  it('draws a merged branch in a lane of its own that rejoins at the fork', () => {
    const rows = layoutGraph([
      commit('M', 'A', 'B'), commit('A', 'C'), commit('B', 'C'), commit('C'),
    ])
    expect(rows.map((r) => `${r.commit.id}@${r.lane}: ${r.segments.map((s) => `${s.kind}${s.from}-${s.to}`).join(' ')}`)).toEqual([
      'M@0: out0-0 out0-1',
      'A@0: in0-0 through1-1 out0-0',
      'B@1: through0-0 in1-1 out1-1',
      'C@0: in0-0 in1-0',
    ])
    expect(rows.map((r) => r.width)).toEqual([2, 2, 2, 2])
    // The merged branch keeps its own colour down to where it rejoins.
    expect(rows[2].color).toBe(rows[0].segments[1].color)
    expect(rows[2].color).not.toBe(rows[0].color)
  })

  it('opens a lane for a branch tip that nothing above leads to', () => {
    expect(shape([commit('X', 'C'), commit('Y', 'C'), commit('C')])).toEqual([
      'X@0: out0-0',
      'Y@1: through0-0 out1-1',
      'C@0: in0-0 in1-0',
    ])
  })

  it('reuses a lane once its branch has ended', () => {
    const rows = layoutGraph([
      commit('Y', 'C'), commit('X', 'C'), commit('C', 'B'), commit('T', 'B'), commit('B'),
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0])
    expect(Math.max(...rows.map((r) => r.width))).toBe(2)
  })

  it('carries on a lane whose parent is beyond the commits loaded', () => {
    expect(shape([commit('b', 'a')])).toEqual(['b@0: out0-0'])
  })
})
