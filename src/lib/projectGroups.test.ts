import { describe, expect, it } from 'vitest'
import { neighbourMoves, projectSections } from './projectGroups'
import type { Project } from './types'

const project = (name: string, category?: string): Project => ({
  id: `p-${name}`,
  name,
  category,
  icon: '',
  color: '#000000',
  root: `/tmp/${name}`,
  instructions: '',
  defaultHarness: 'default',
  createdAt: 0,
  lastOpenedAt: 0,
})

const shape = (projects: Project[]) =>
  projectSections(projects).map((s) => [
    s.category,
    s.projects.map((e) => `${e.project.name}@${e.index}`),
  ])

describe('projectSections', () => {
  it('lists projects without a category first, then categories alphabetically', () => {
    const list = [
      project('a', 'Work'), project('b'), project('c', 'Clients'), project('d', 'Work'),
      project('e'),
    ]
    expect(shape(list)).toEqual([
      ['', ['b@1', 'e@4']],
      ['Clients', ['c@2']],
      ['Work', ['a@0', 'd@3']],
    ])
  })

  it('treats a blank category as none and ignores surrounding spaces', () => {
    expect(shape([project('a', '  '), project('b', ' Work '), project('c', 'Work')])).toEqual([
      ['', ['a@0']],
      ['Work', ['b@1', 'c@2']],
    ])
  })

  it('has no section without a category when every project has one', () => {
    expect(shape([project('a', 'Work')])).toEqual([['Work', ['a@0']]])
  })
})

describe('neighbourMoves', () => {
  const list = [project('a', 'Work'), project('b'), project('c', 'Work'), project('d', 'Work')]

  it('moves past the neighbour in the same category', () => {
    // b sits between a and c in the full list, but in another section.
    expect(neighbourMoves(list, 2)).toEqual({ up: 0, down: 4 })
  })

  it('stops at the edges of the category', () => {
    expect(neighbourMoves(list, 0)).toEqual({ up: null, down: 3 })
    expect(neighbourMoves(list, 3)).toEqual({ up: 2, down: null })
    expect(neighbourMoves(list, 1)).toEqual({ up: null, down: null })
  })

  it('is plain move up and down when nothing has a category', () => {
    const flat = ['a', 'b', 'c'].map((n) => project(n))
    expect(neighbourMoves(flat, 1)).toEqual({ up: 0, down: 3 })
  })

  it('offers nothing for a project that is gone', () => {
    expect(neighbourMoves(list, -1)).toEqual({ up: null, down: null })
  })
})
