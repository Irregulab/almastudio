/**
 * Quoting for file paths typed into a terminal, matching what a native
 * terminal inserts when a file is dropped on it.
 */

/** ASCII characters a POSIX shell gives a meaning to inside a word. */
const POSIX_SPECIAL = /[\s!"#$&'()*;<>?[\\\]^`{|}]/g
const CONTROL = /[\x00-\x1f\x7f]/

/** Backslash-escapes the specials, as Terminal.app and iTerm do. */
export function quotePosix(path: string): string {
  if (path === '') return "''"
  // A backslash before a newline is a line continuation, not an escaped
  // newline, so names containing control characters are single-quoted.
  if (CONTROL.test(path)) return `'${path.replace(/'/g, `'\\''`)}'`
  return path.replace(POSIX_SPECIAL, '\\$&')
}

/** Double-quotes a path when cmd or PowerShell would otherwise split it. */
export function quoteWindows(path: string): string {
  // Windows forbids `"` in file names, so wrapping needs no escaping.
  return /[\s&()[\]{}^=;!'+,`~%$@]/.test(path) ? `"${path}"` : path
}

/**
 * Paths ready to type at a prompt: quoted for the platform's shell, separated
 * by spaces, with a trailing space so the next argument can follow.
 */
export function quotePaths(paths: string[], platform: string): string {
  const quote = platform === 'windows' ? quoteWindows : quotePosix
  return `${paths.map(quote).join(' ')} `
}
