import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, GitBranch, Maximize2, Pin } from 'lucide-react'

import { findGitRepos, gitStatus, type RepoEntry } from '../lib/ipc'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import type { RepoStatus } from '../lib/types'

/**
 * Shown instead of a bare "not a git repository": a folder full of projects is
 * a reasonable thing to point AlmaStudio at, and the repositories underneath
 * it are what the user actually meant.
 *
 * They are listed as an accordion rather than as a menu that swaps the panel
 * over to one of them. Drilling in was a one-way door — nothing on screen said
 * how to get back out — and with several repositories the useful view is all
 * of them at once, not one at a time.
 */
export function RepoAccordion({
  projectId, root, render, onFocus,
}: {
  /** Whose pinned repositories are listed first. */
  projectId: string
  root: string
  /** Body for one repository, rendered only while its section is open. */
  render: (repo: RepoEntry) => React.ReactNode
  onFocus: (path: string) => void
}) {
  const t = useT()
  const [repos, setRepos] = useState<RepoEntry[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const autoExpanded = useRef('')
  const pinned = useWorkspace((s) => s.projects.find((p) => p.id === projectId)?.pinnedRepos)
  const togglePinnedRepo = useWorkspace((s) => s.togglePinnedRepo)

  useEffect(() => {
    let cancelled = false
    setRepos(null)
    void findGitRepos(root, 3)
      .then((r) => !cancelled && setRepos(r))
      .catch(() => !cancelled && setRepos([]))
    return () => {
      cancelled = true
    }
  }, [root])

  // Open the repositories that have something to show, once per folder — the
  // ones with changes are why the panel is being looked at.
  useEffect(() => {
    if (!repos || autoExpanded.current === root) return
    autoExpanded.current = root
    const dirty = repos.filter((r) => r.dirty > 0).map((r) => r.path)
    setOpen(new Set(dirty.length ? dirty.slice(0, 4) : repos.slice(0, 1).map((r) => r.path)))
  }, [repos, root])

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  // Pinned repositories first; each part keeps the order they were found in.
  const ordered = useMemo(() => {
    const list = repos ?? []
    if (!pinned?.length) return list
    return [
      ...list.filter((r) => pinned.includes(r.path)),
      ...list.filter((r) => !pinned.includes(r.path)),
    ]
  }, [repos, pinned])

  if (repos === null) {
    return (
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('common.loading')}</div>
      </div>
    )
  }

  if (repos.length === 0) {
    return (
      <div className="empty">
        <GitBranch size={22} />
        <div>{t('panel.noRepo')}</div>
        <div className="subtle">{t('panel.noRepoHint', { folder: root })}</div>
      </div>
    )
  }

  return (
    <>
      <p className="discovery__hint">
        {t('panel.reposHint', { n: repos.length })}
      </p>
      {ordered.map((repo) => {
        const isOpen = open.has(repo.path)
        const isPinned = pinned?.includes(repo.path) ?? false
        return (
          <section key={repo.path} className="group repo">
            <header className="group__head">
              <button className="group__toggle" onClick={() => toggle(repo.path)}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <GitBranch size={12} />
                <span className="repo__name truncate">{repo.name}</span>
                {repo.branch && <span className="chip">{repo.branch}</span>}
                {repo.dirty > 0 && <span className="chip chip--dirty">{repo.dirty}</span>}
              </button>
              <button
                className={`icon-btn icon-btn--tiny${isPinned ? ' repo__pin--on' : ''}`}
                title={isPinned ? t('panel.unpinRepo') : t('panel.pinRepo')}
                aria-pressed={isPinned}
                onClick={() => togglePinnedRepo(projectId, repo.path)}
              >
                <Pin size={12} fill={isPinned ? 'currentColor' : 'none'} />
              </button>
              <button
                className="icon-btn icon-btn--tiny"
                title={t('panel.focusRepo')}
                onClick={() => onFocus(repo.path)}
              >
                <Maximize2 size={12} />
              </button>
            </header>
            {isOpen && <div className="repo__body">{render(repo)}</div>}
          </section>
        )
      })}
    </>
  )
}

/** Fetches one repository's status for a section that is actually open. */
export function useRepoStatus(root: string, revision: number) {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void gitStatus(root)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null))
    return () => {
      cancelled = true
    }
  }, [root, revision])
  return status
}
