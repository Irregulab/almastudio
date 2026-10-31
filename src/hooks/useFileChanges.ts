import { useEffect, useRef } from 'react'

import { onFsChange, watchStart, watchStop } from '../lib/ipc'
import { parentDir, touchesFile } from '../lib/watchedFile'

let watches = 0

/**
 * Calls `onChange` when a file changes on disk, for as long as `enabled`.
 *
 * Watches the file's folder, not the file: editors and agents often save by
 * replacing a file, which would end a watch on the file itself. Each run has
 * its own id, so a stop arriving late cannot end the watch that followed it.
 */
export function useFileChanges(path: string, enabled: boolean, onChange: () => void) {
  const callback = useRef(onChange)
  callback.current = onChange

  useEffect(() => {
    if (!enabled) return
    const id = `file-${++watches}`
    let unlisten: (() => void) | undefined
    let cancelled = false
    let started = false
    const stop = () => { void watchStop(id).catch(() => {}) }

    void (async () => {
      const off = await onFsChange(id, (change) => {
        if (touchesFile(change, path)) callback.current()
      })
      if (cancelled) {
        off()
        return
      }
      unlisten = off
      await watchStart(id, parentDir(path), false).catch(() => {})
      started = true
      if (cancelled) stop()
    })()

    return () => {
      cancelled = true
      unlisten?.()
      if (started) stop()
    }
  }, [path, enabled])
}
