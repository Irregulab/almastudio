import { useEffect, useState } from 'react'

import { installedHarnesses } from '../lib/ipc'
import { useSettings } from '../store/settings'
import type { HarnessKind } from '../lib/types'

/** The AI harnesses, in menu order. A shell is always there to run. */
export const HARNESSES: HarnessKind[] = ['claude', 'codex', 'opencode']

/**
 * The harnesses whose command is installed, which are the only ones offered —
 * as Visual Studio Code and IntelliJ are offered only when installed. Until
 * the answer comes back, and if it never does, all of them are: hiding one
 * that is in fact installed would leave no way to start it.
 */
export function useInstalledHarnesses(): HarnessKind[] {
  const harness = useSettings((s) => s.settings.harness)
  const loaded = useSettings((s) => s.loaded)
  const [installed, setInstalled] = useState<HarnessKind[] | null>(null)
  const commands = HARNESSES.map((kind) => harness[kind].command)
  const key = commands.join('\n')

  useEffect(() => {
    // Before the settings are loaded the commands are the defaults, which
    // would answer for someone else's machine.
    if (!loaded) return
    let live = true
    void installedHarnesses(commands)
      .then((found) => {
        if (live) setInstalled(HARNESSES.filter((kind) => found.includes(harness[kind].command)))
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // Looked up again whenever a harness's command is changed in the settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, key])

  return installed ?? HARNESSES
}
