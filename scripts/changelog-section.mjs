#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md, without its heading.
 *
 * Usage: node scripts/changelog-section.mjs <version> [changelog]
 *
 * Exits non-zero when the version has no section, or an empty one, so a
 * release cannot go out without its notes.
 */
import { readFileSync } from 'node:fs'

const [version, file = 'CHANGELOG.md'] = process.argv.slice(2)
if (!version) {
  console.error('usage: changelog-section.mjs <version> [changelog]')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split('\n')
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`)
const start = lines.findIndex((line) => heading.test(line))
if (start < 0) {
  console.error(`${file} has no section for ${version}: add "## [${version}] - <date>" before releasing`)
  process.exit(1)
}

// The section runs to the next version heading or the link references.
let end = lines.findIndex((line, i) => i > start && (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)))
if (end < 0) end = lines.length

const body = lines.slice(start + 1, end).join('\n').trim()
if (!body) {
  console.error(`the ${version} section of ${file} is empty`)
  process.exit(1)
}
process.stdout.write(`${body}\n`)
