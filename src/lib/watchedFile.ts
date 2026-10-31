import type { ChangePayload } from './ipc'

const baseName = (path: string) => path.split(/[/\\]/).pop() ?? path

/** The folder a file is in. */
export function parentDir(path: string): string {
  const end = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return end > 0 ? path.slice(0, end) : path.slice(0, end + 1)
}

/**
 * Whether a change reported for a file's folder may be the file.
 *
 * By name, because the watcher reports real paths, which do not match one that
 * goes through a symlink; the watch covers that one folder, so a name is enough.
 * A burst can list fewer paths than it counted, and then the file may be among
 * the ones left out.
 */
export function touchesFile(change: Pick<ChangePayload, 'paths' | 'count'>, path: string): boolean {
  if (change.count > change.paths.length) return true
  const name = baseName(path)
  return change.paths.some((p) => baseName(p) === name)
}
