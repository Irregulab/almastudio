import { useEffect } from 'react'

import { gitFetch, gitStatus } from '../lib/ipc'

/** Tells the views showing git state that it changed without them doing it. */
export const GIT_CHANGED_EVENT = 'almastudio:git-changed'

/**
 * VS Code's git.autofetch: fetches the repository in view every `minutes`, so
 * the branch shows what is waiting to be pulled without anyone asking.
 */
export function useAutoFetch(root: string, minutes: number) {
  useEffect(() => {
    if (!root || minutes <= 0) return
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        const status = await gitStatus(root)
        if (!status.isRepo || !status.upstream) return
        await gitFetch(root)
        window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT))
      } catch {
        // Offline, or the remote refused: the next round tries again.
      } finally {
        running = false
      }
    }
    const timer = window.setInterval(() => void tick(), minutes * 60_000)
    return () => window.clearInterval(timer)
  }, [root, minutes])
}
