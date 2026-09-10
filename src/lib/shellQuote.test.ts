import { describe, expect, it } from 'vitest'
import { quotePaths, quotePosix, quoteWindows } from './shellQuote'

describe('quotePosix', () => {
  it('leaves ordinary paths alone', () => {
    expect(quotePosix('/Users/me/project/src/main.rs')).toBe('/Users/me/project/src/main.rs')
    expect(quotePosix('/tmp/a-b_c.d,e:f@g%h+i=j~k')).toBe('/tmp/a-b_c.d,e:f@g%h+i=j~k')
  })

  it('backslash-escapes spaces and shell specials', () => {
    expect(quotePosix('/Users/me/Screenshot 2026-09-10 at 12.00.png')).toBe(
      '/Users/me/Screenshot\\ 2026-09-10\\ at\\ 12.00.png',
    )
    expect(quotePosix("/a/it's (1) [x] $HOME & *.md")).toBe(
      "/a/it\\'s\\ \\(1\\)\\ \\[x\\]\\ \\$HOME\\ \\&\\ \\*.md",
    )
  })

  it('keeps non-ASCII names readable', () => {
    expect(quotePosix('/Users/me/perché/città 🎨.txt')).toBe('/Users/me/perché/città\\ 🎨.txt')
  })

  it('single-quotes names with control characters', () => {
    expect(quotePosix("/tmp/line\nbreak's")).toBe("'/tmp/line\nbreak'\\''s'")
  })
})

describe('quoteWindows', () => {
  it('wraps only when needed', () => {
    expect(quoteWindows('C:\\Users\\me\\file.txt')).toBe('C:\\Users\\me\\file.txt')
    expect(quoteWindows('C:\\Program Files\\x.exe')).toBe('"C:\\Program Files\\x.exe"')
    expect(quoteWindows('C:\\a&b\\c.txt')).toBe('"C:\\a&b\\c.txt"')
  })
})

describe('quotePaths', () => {
  it('joins several paths and leaves room for the next argument', () => {
    expect(quotePaths(['/a b', '/c'], 'macos')).toBe('/a\\ b /c ')
    expect(quotePaths(['C:\\a b'], 'windows')).toBe('"C:\\a b" ')
  })
})
