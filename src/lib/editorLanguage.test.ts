import { describe, expect, it } from 'vitest'

import { describeFile, languageFor } from './editorLanguage'

const nameOf = (path: string) => describeFile(path)?.name ?? null

describe('describeFile', () => {
  it.each([
    ['src/App.tsx', 'TSX'],
    ['src/main.ts', 'TypeScript'],
    ['lib.mjs', 'JavaScript'],
    ['main.go', 'Go'],
    ['Main.kt', 'Kotlin'],
    ['Program.cs', 'C#'],
    ['app.rb', 'Ruby'],
    ['App.swift', 'Swift'],
    ['run.sh', 'Shell'],
    ['Cargo.toml', 'TOML'],
    ['init.lua', 'Lua'],
    ['fix.patch', 'diff'],
    ['style.scss', 'SCSS'],
    ['style.sass', 'Sass'],
    ['style.less', 'LESS'],
    ['App.vue', 'Vue'],
  ])('finds the grammar for %s', (path, name) => {
    expect(nameOf(path)).toBe(name)
  })

  it.each([
    ['tsconfig.jsonc', 'JSON'],
    ['config.json5', 'JSON'],
    ['types.pyi', 'Python'],
    ['post.mdx', 'Markdown'],
    ['App.svelte', 'HTML'],
    ['.zshrc.zsh', 'Shell'],
    ['config.fish', 'Shell'],
    ['.env', 'Properties files'],
    ['setup.cfg', 'Properties files'],
    ['app.conf', 'Properties files'],
    ['Foo.m', 'Objective-C'],
  ])('uses the nearest grammar for %s', (path, name) => {
    expect(nameOf(path)).toBe(name)
  })

  it.each([
    ['Dockerfile', 'Dockerfile'],
    ['dockerfile', 'Dockerfile'],
    ['Dockerfile.dev', 'Dockerfile'],
    ['Makefile', 'Shell'],
    ['GNUmakefile', 'Shell'],
    ['Gemfile', 'Ruby'],
    ['nginx.conf', 'Nginx'],
    ['CMakeLists.txt', 'CMake'],
  ])('recognises %s by name', (path, name) => {
    expect(nameOf(path)).toBe(name)
  })

  it('finds the file name on either kind of path', () => {
    expect(nameOf('/project/docker/Dockerfile')).toBe('Dockerfile')
    expect(nameOf('C:\\project\\main.go')).toBe('Go')
  })

  it('does not depend on the case of an extension', () => {
    expect(nameOf('MAIN.GO')).toBe('Go')
    expect(nameOf('script.R')).toBe('R')
  })

  it.each(['notes.txt', 'notes.text', 'app.log', 'app.log.1', 'LICENSE', '.gitignore', 'data.unknown'])(
    'leaves %s as plain text',
    (path) => {
      expect(describeFile(path)).toBeNull()
    },
  )

  it('points every mapping at a grammar that exists', () => {
    for (const path of ['a.cfg', 'a.conf', 'a.env', 'a.fish', 'a.json5', 'a.jsonc', 'a.m', 'a.mdx', 'a.pyi', 'a.svelte', 'a.zsh', 'Makefile', 'Dockerfile']) {
      expect(describeFile(path), path).not.toBeNull()
    }
  })
})

describe('languageFor', () => {
  it('loads modern and legacy grammars alike', async () => {
    expect(await languageFor('main.go')).not.toBeNull()
    expect(await languageFor('Main.kt')).not.toBeNull()
    expect(await languageFor('Makefile')).not.toBeNull()
  })

  it('has nothing for a file without a grammar', async () => {
    expect(await languageFor('notes.txt')).toBeNull()
  })
})
