/** Short, collision-resistant ids. These end up as filenames for persisted
 *  scrollback, so keep them to characters the backend's sanitiser preserves. */
export function uid(prefix = 'id'): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return `${prefix}-${rand}`
}
