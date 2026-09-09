import { describe, expect, it } from 'vitest'
import { deepMerge } from './merge'

describe('deepMerge', () => {
  const base = {
    theme: 'system',
    ui: { fontSize: 13, density: 'comfortable' },
    harness: { claude: { command: 'claude', args: ['--foo'] } },
  }

  it('keeps defaults for keys the stored file predates', () => {
    const out = deepMerge(base, { theme: 'dark' })
    expect(out.theme).toBe('dark')
    expect(out.ui.fontSize).toBe(13)
    expect(out.harness.claude.command).toBe('claude')
  })

  it('drops keys that no longer exist in the defaults', () => {
    const out = deepMerge(base, { removedSetting: true, theme: 'light' }) as typeof base &
      Record<string, unknown>
    expect(out.removedSetting).toBeUndefined()
    expect(out.theme).toBe('light')
  })

  it('replaces arrays wholesale rather than merging by index', () => {
    // A user who cleared an argument list means it; index-merging would
    // resurrect the defaults they deleted.
    expect(deepMerge(base, { harness: { claude: { args: [] } } }).harness.claude.args).toEqual([])
    expect(
      deepMerge(base, { harness: { claude: { args: ['--bar'] } } }).harness.claude.args,
    ).toEqual(['--bar'])
  })

  it('ignores a value whose type does not match the default', () => {
    expect(deepMerge(base, { theme: 42 }).theme).toBe('system')
  })

  it('survives null, undefined and non-objects', () => {
    expect(deepMerge(base, null)).toBe(base)
    expect(deepMerge(base, undefined)).toBe(base)
    expect(deepMerge(base, 'nonsense')).toBe(base)
  })

  it('does not mutate the defaults it merges onto', () => {
    const snapshot = JSON.stringify(base)
    deepMerge(base, { ui: { fontSize: 20 } })
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})
