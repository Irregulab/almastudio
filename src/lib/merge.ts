/** Deep-merges persisted state onto defaults.
 *
 * Settings files outlive releases: a v0.1 file must still load in v0.4 with
 * the keys added since then filled in from the defaults, and any key that has
 * since been removed simply ignored. Arrays are replaced wholesale — a user
 * who cleared an argument list means it, and merging by index would resurrect
 * defaults they deleted. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T
  if (typeof base !== 'object' || typeof patch !== 'object') {
    return (typeof patch === typeof base ? patch : base) as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue
    out[k] = deepMerge(out[k], v)
  }
  return out as T
}
