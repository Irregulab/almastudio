import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { cancelExit, confirmExit, onCloseRequested } from '../lib/ipc'
import { isTerminalTab } from '../lib/types'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog } from './ui'

/**
 * Confirms shutdown, because quitting kills every running agent.
 *
 * The backend holds the close and asks here; nothing exits until this answers.
 * The prompt names what is actually at stake rather than asking an abstract
 * "are you sure", and says nothing at all when there is nothing to lose.
 */
export function ExitGuard() {
  const t = useT()
  const confirmOnExit = useSettings((s) => s.settings.startup.confirmOnExit)
  const tabs = useWorkspace((s) => s.tabs)
  const dirtyTabs = useUi((s) => s.dirtyTabs)
  const [asking, setAsking] = useState(false)

  const stakes = useMemo(() => {
    const running = Object.values(tabs).filter(
      (tab) => isTerminalTab(tab) && (tab.status === 'running' || tab.status === 'starting'),
    ).length
    const unsaved = Object.keys(dirtyTabs).length
    return { running, unsaved }
  }, [tabs, dirtyTabs])

  // Read through a ref so the listener is registered once rather than being
  // torn down and re-registered every time a tab's status changes.
  const stakesRef = useRef(stakes)
  stakesRef.current = stakes

  const quit = useCallback(() => {
    void confirmExit().catch(() => {})
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onCloseRequested(() => {
      const { running, unsaved } = stakesRef.current
      // Nothing running and nothing unsaved: there is nothing to confirm.
      if (!confirmOnExit || (running === 0 && unsaved === 0)) {
        quit()
        return
      }
      setAsking(true)
    }).then((un) => (unlisten = un))
    return () => unlisten?.()
  }, [confirmOnExit, quit])

  if (!asking) return null

  const parts: string[] = []
  if (stakes.running > 0) parts.push(t('exit.running', { n: stakes.running }))
  if (stakes.unsaved > 0) parts.push(t('exit.unsaved', { n: stakes.unsaved }))

  return (
    <ConfirmDialog
      title={t('exit.title')}
      message={`${parts.join(' · ')}\n\n${t('exit.body')}`}
      confirmLabel={t('exit.quit')}
      danger
      onCancel={() => {
        setAsking(false)
        void cancelExit().catch(() => {})
      }}
      onConfirm={quit}
    />
  )
}
