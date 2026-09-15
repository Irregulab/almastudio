import { useState } from 'react'

import {
  gitCreateBranch, gitCreateTag, gitDeleteBranch, gitDeleteRemoteBranch, gitDeleteTag,
  gitRenameBranch, gitReset, gitStashDrop,
} from '../lib/ipc'
import { useT } from '../i18n'
import { ConfirmDialog, PromptDialog } from './ui'
import type { StashInfo } from '../lib/types'

/** The prompts and confirmations git operations ask for before running. */
export type GitDialog =
  /** `base` names where the branch starts, for the title; `start` is that commit. */
  | { kind: 'new-branch'; base: string; start?: string }
  | { kind: 'rename-branch'; name: string }
  | { kind: 'delete-branch'; name: string; force: boolean }
  | { kind: 'delete-remote-branch'; name: string }
  | { kind: 'new-tag'; base: string; target?: string }
  | { kind: 'delete-tag'; name: string }
  | { kind: 'drop-stash'; stash: StashInfo }
  | { kind: 'reset'; id: string; shortId: string; mode: 'soft' | 'mixed' | 'hard'; branch: string }

const RESET_CONFIRM = {
  soft: 'graph.resetSoftConfirm',
  mixed: 'graph.resetMixedConfirm',
  hard: 'graph.resetHardConfirm',
} as const

/**
 * Git operations the way the Git panel and Git Graph both run them: one at a
 * time, a failure shown rather than thrown, a short notice on success and the
 * view refreshed after — with the dialogs some of them need first.
 */
export function useGitActions(root: string, onChanged: () => void) {
  const t = useT()
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<GitDialog | null>(null)

  const flash = (text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice(null), 2500)
  }

  const run = async (name: string, op: () => Promise<unknown>, done?: string) => {
    setRunning(name)
    setError(null)
    setNotice(null)
    try {
      await op()
      if (done) flash(done)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(null)
      onChanged()
    }
  }

  // An unmerged branch is only deleted once the user has confirmed twice.
  const deleteBranch = (name: string, force: boolean) =>
    run('delete-branch', async () => {
      try {
        await gitDeleteBranch(root, name, force)
      } catch (e) {
        if (force || !/not fully merged/i.test(String(e))) throw e
        setDialog({ kind: 'delete-branch', name, force: true })
      }
    })

  const close = () => setDialog(null)
  let dialogs: React.ReactNode = null
  if (dialog) {
    switch (dialog.kind) {
      case 'new-branch': {
        const { base, start } = dialog
        dialogs = (
          <PromptDialog
            title={t('git.newBranchTitle', { base })} label={t('git.branchName')}
            confirmLabel={t('git.create')} onCancel={close}
            onConfirm={(name) => {
              close()
              void run('new-branch', () => gitCreateBranch(root, name, start ?? null, true))
            }}
          />
        )
        break
      }
      case 'rename-branch': {
        const from = dialog.name
        dialogs = (
          <PromptDialog
            title={t('git.renameTitle', { name: from })} label={t('git.branchName')}
            initial={from} confirmLabel={t('common.save')} onCancel={close}
            onConfirm={(name) => {
              close()
              if (name !== from) void run('rename', () => gitRenameBranch(root, from, name))
            }}
          />
        )
        break
      }
      case 'delete-branch': {
        const { name, force } = dialog
        dialogs = (
          <ConfirmDialog
            title={t('git.deleteBranchTitle')}
            message={force ? t('git.forceDeleteConfirm', { name }) : t('git.deleteBranchConfirm', { name })}
            confirmLabel={t('common.delete')} danger onCancel={close}
            onConfirm={() => {
              close()
              void deleteBranch(name, force)
            }}
          />
        )
        break
      }
      case 'delete-remote-branch': {
        const { name } = dialog
        dialogs = (
          <ConfirmDialog
            title={t('git.deleteRemoteBranch')} message={t('git.deleteRemoteConfirm', { name })}
            confirmLabel={t('common.delete')} danger onCancel={close}
            onConfirm={() => {
              close()
              void run('delete-remote', () => gitDeleteRemoteBranch(root, name))
            }}
          />
        )
        break
      }
      case 'new-tag': {
        const { base, target } = dialog
        dialogs = (
          <PromptDialog
            title={t('git.newTagTitle', { base })} label={t('git.tagName')}
            confirmLabel={t('git.create')} onCancel={close}
            onConfirm={(name) => {
              close()
              void run('new-tag', () => gitCreateTag(root, name, null, target ?? null))
            }}
          />
        )
        break
      }
      case 'delete-tag': {
        const { name } = dialog
        dialogs = (
          <ConfirmDialog
            title={t('git.deleteTag')} message={t('git.deleteTagConfirm', { name })}
            confirmLabel={t('common.delete')} danger onCancel={close}
            onConfirm={() => {
              close()
              void run('delete-tag', () => gitDeleteTag(root, name))
            }}
          />
        )
        break
      }
      case 'drop-stash': {
        const { stash } = dialog
        dialogs = (
          <ConfirmDialog
            title={t('git.stashDrop')} message={t('git.stashDropConfirm', { name: stash.message })}
            confirmLabel={t('common.delete')} danger onCancel={close}
            onConfirm={() => {
              close()
              void run('stash-drop', () => gitStashDrop(root, stash.index))
            }}
          />
        )
        break
      }
      case 'reset': {
        const { id, shortId, mode, branch } = dialog
        dialogs = (
          <ConfirmDialog
            title={t('graph.resetTitle', { current: branch })}
            message={t(RESET_CONFIRM[mode], { current: branch, commit: shortId })}
            confirmLabel={t('graph.reset')} danger={mode === 'hard'} onCancel={close}
            onConfirm={() => {
              close()
              void run('reset', () => gitReset(root, id, mode))
            }}
          />
        )
        break
      }
    }
  }

  return {
    running,
    busy: running !== null,
    notice,
    error,
    flash,
    run,
    ask: setDialog,
    dialogs,
  }
}
