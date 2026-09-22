import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitView } from './GitView'
import { useWorkspace } from '../store/workspace'
import type { CommitDetails, GraphCommit, Project, RepoStatus } from '../lib/types'
import {
  gitBranches, gitCommitDetails, gitGraph, gitStashes, gitTags,
} from '../lib/ipc'

vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc')
  return {
    ...actual,
    gitBranches: vi.fn(),
    gitCommitDetails: vi.fn(),
    gitGraph: vi.fn(),
    gitStashes: vi.fn(),
    gitTags: vi.fn(),
  }
})

const mockedGitBranches = vi.mocked(gitBranches)
const mockedGitCommitDetails = vi.mocked(gitCommitDetails)
const mockedGitGraph = vi.mocked(gitGraph)
const mockedGitStashes = vi.mocked(gitStashes)
const mockedGitTags = vi.mocked(gitTags)

const project: Project = {
  id: 'p-test',
  name: 'Test',
  icon: '',
  color: '#000000',
  root: '/repo',
  instructions: '',
  defaultHarness: 'default',
  createdAt: 0,
  lastOpenedAt: 0,
}

const status: RepoStatus = {
  isRepo: true,
  root: '/repo',
  branch: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  files: [],
  operation: null,
}

const commit: GraphCommit = {
  id: '1234567890abcdef',
  shortId: '1234567',
  parents: ['abcdef1234567890'],
  summary: 'Fix history details',
  author: 'Alice',
  email: 'alice@example.com',
  time: 1_700_000_000,
  refs: [],
}

const details: CommitDetails = {
  id: commit.id,
  shortId: commit.shortId,
  parents: commit.parents,
  message: commit.summary,
  author: commit.author,
  email: commit.email,
  authorTime: commit.time,
  committer: commit.author,
  committerEmail: commit.email,
  commitTime: commit.time,
  files: [{
    path: 'src/app.ts',
    oldPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
  }],
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('GitView history details', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    useWorkspace.setState({
      projects: [project],
      tabs: {},
      workspaces: {},
      activeProjectId: project.id,
      loaded: true,
    })
    mockedGitGraph.mockResolvedValue([commit])
    mockedGitBranches.mockResolvedValue([])
    mockedGitStashes.mockResolvedValue([])
    mockedGitTags.mockResolvedValue([])
    mockedGitCommitDetails.mockResolvedValue(details)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount())
    }
    host.remove()
    vi.clearAllMocks()
  })

  it('shows changed files for a clicked commit and opens diff tabs as preview or pinned', async () => {
    await act(async () => {
      root = createRoot(host)
      root.render(<GitView projectId={project.id} root={project.root} status={status} onChanged={() => {}} />)
    })
    await flush()
    await flush()

    const row = host.querySelector('.graph__row')
    expect(row).not.toBeNull()

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    await flush()

    expect(mockedGitCommitDetails).toHaveBeenCalledWith(project.root, commit.id)
    expect(row!.className).toContain('is-selected')
    expect(host.textContent).toContain('src/app.ts')

    const file = host.querySelector('.ggraph__details .filerow')
    expect(file).not.toBeNull()

    await act(async () => {
      file!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    let diff = Object.values(useWorkspace.getState().tabs).find((t) => t.kind === 'diff')
    expect(diff).toMatchObject({
      kind: 'diff',
      projectId: project.id,
      root: project.root,
      path: 'src/app.ts',
      target: commit.id,
      preview: true,
    })

    await act(async () => {
      file!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    diff = Object.values(useWorkspace.getState().tabs).find((t) => t.kind === 'diff')
    expect(diff).toMatchObject({
      kind: 'diff',
      projectId: project.id,
      root: project.root,
      path: 'src/app.ts',
      target: commit.id,
      preview: false,
    })
  })
})
