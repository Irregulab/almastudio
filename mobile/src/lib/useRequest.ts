import { useCallback, useEffect, useState } from 'react'

import type { RemoteConnection } from '@almastudio/protocol/src/client'
import { useConnection } from './connection'

/** Runs a request against the open connection, again whenever `deps` change. */
export function useRequest<T>(
  run: (conn: RemoteConnection) => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const conn = useConnection((s) => s.conn)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!conn) {
      setError('Not connected to the computer.')
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    setError(null)
    run(conn).then(
      (d) => live && (setData(d), setLoading(false)),
      (e) => live && (setError(String(e?.message ?? e)), setLoading(false)),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, tick, ...deps])

  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) }
}

/** The project the main screen shows; every page works within it. */
export function useProject() {
  return useConnection((s) => s.workspace?.projects.find((p) => p.id === s.projectId) ?? null)
}

export const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path

export function timeAgo(seconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - seconds)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(seconds * 1000).toLocaleDateString()
}
