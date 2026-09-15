import { useState } from 'react'
import { Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { create } from 'zustand'

import { gitCommit, gitPush, gitSync } from '../lib/ipc'
import { useT } from '../i18n'
import { MenuItem, MenuSeparator, Popover } from './ui'
import type { RepoStatus } from '../lib/types'

/**
 * The message being written, per repository, so the Changes and Git views
 * show the same box.
 */
const useMessages = create<Record<string, string>>(() => ({}))

/** Puts a message in a repository's commit box, as Undo Last Commit does. */
export const setCommitMessage = (root: string, message: string) =>
  useMessages.setState((s) => ({ ...s, [root]: message }))

type Mode = 'staged' | 'all' | 'amend' | 'push' | 'sync'

/**
 * VS Code's commit box: a message, Commit — the staged changes, or every
 * change when nothing is staged — with the other ways to commit beside it,
 * and Sync Changes while the branch is ahead of or behind its upstream.
 */
export function CommitBox({
  root, status, onChanged,
}: { root: string; status: RepoStatus; onChanged: () => void }) {
  const t = useT()
  const message = useMessages((s) => s[root] ?? '')
  const [busy, setBusy] = useState<Mode | 'sync-only' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)

  const staged = status.files.filter((f) => f.staged).length
  const changes = status.files.length
  const hasMessage = message.trim().length > 0
  const primary: Mode = staged > 0 ? 'staged' : 'all'
  // Concluding a merge is a commit too, even with nothing left to change.
  const canCommit = hasMessage && (changes > 0 || status.operation === 'merge')

  const commit = async (mode: Mode) => {
    setMenu(null)
    setBusy(mode)
    setError(null)
    try {
      const stageAll = mode === 'all' || ((mode === 'push' || mode === 'sync') && staged === 0)
      await gitCommit(root, message, stageAll, mode === 'amend')
      setCommitMessage(root, '')
      if (mode === 'push') await gitPush(root)
      if (mode === 'sync') await gitSync(root)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const sync = async () => {
    setBusy('sync-only')
    setError(null)
    try {
      await gitSync(root)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  return (
    <div className="git__commit">
      <textarea
        className="textarea" rows={3} value={message}
        placeholder={t('git.messagePlaceholder')}
        onChange={(e) => setCommitMessage(root, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (canCommit && busy === null) void commit(primary)
          }
        }}
      />
      <div className="commitbtn">
        <button
          className="btn btn--primary btn--sm commitbtn__main"
          disabled={!canCommit || busy !== null}
          title={staged > 0 ? t('git.commitHintStaged', { n: staged }) : t('git.commitHintAll')}
          onClick={() => void commit(primary)}
        >
          {busy !== null && busy !== 'sync-only'
            ? <Loader2 size={13} className="spin" />
            : <Check size={13} />}
          {t('git.commit')}{staged > 0 ? ` (${staged})` : ''}
        </button>
        <button
          className="btn btn--primary btn--sm commitbtn__more"
          aria-label={t('git.moreCommit')} title={t('git.moreCommit')}
          disabled={busy !== null}
          onClick={(e) => setMenu(e.currentTarget)}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {status.upstream && !status.detached && (status.ahead > 0 || status.behind > 0) && (
        <button className="btn btn--sm git__syncbtn" disabled={busy !== null} onClick={() => void sync()}>
          {busy === 'sync-only' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          {t('git.sync')}
          {status.behind > 0 && ` ↓${status.behind}`}
          {status.ahead > 0 && ` ↑${status.ahead}`}
        </button>
      )}
      {error && <div className="git__error">{error}</div>}

      <Popover anchor={menu} open={!!menu} onClose={() => setMenu(null)} align="end">
        <MenuItem
          label={t('git.commitStaged')} disabled={!hasMessage || staged === 0}
          onClick={() => void commit('staged')}
        />
        <MenuItem
          label={t('git.commitAll')} disabled={!hasMessage || changes === 0}
          onClick={() => void commit('all')}
        />
        <MenuItem label={t('git.commitAmend')} onClick={() => void commit('amend')} />
        <MenuSeparator />
        <MenuItem
          label={t('git.commitPush')} disabled={!hasMessage || changes === 0 || status.detached}
          onClick={() => void commit('push')}
        />
        <MenuItem
          label={t('git.commitSync')}
          disabled={!hasMessage || changes === 0 || !status.upstream || status.detached}
          onClick={() => void commit('sync')}
        />
      </Popover>
    </div>
  )
}
