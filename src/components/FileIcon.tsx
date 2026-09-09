import {
  Braces, Coffee, Database, FileArchive, FileCode2, FileImage, FileJson,
  FileLock2, FileText, FileType2, Folder, FolderOpen, Hash, Settings2,
  SquareTerminal, Type,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** Icon plus colour for a file type, in the spirit of VS Code's file icons.
 *
 * Built from the lucide set already in the bundle rather than shipping an icon
 * theme: a few hundred bytes instead of a few hundred kilobytes, and the
 * glyphs match the rest of the UI. Colours are the familiar
 * language-identity ones (TypeScript blue, Rust rust, Go cyan, …). */

interface Spec {
  Icon: LucideIcon
  color: string
}

const CODE = FileCode2

const BY_EXT: Record<string, Spec> = {
  ts: { Icon: CODE, color: '#3178c6' },
  tsx: { Icon: CODE, color: '#3178c6' },
  mts: { Icon: CODE, color: '#3178c6' },
  cts: { Icon: CODE, color: '#3178c6' },
  js: { Icon: CODE, color: '#e8d44d' },
  jsx: { Icon: CODE, color: '#e8d44d' },
  mjs: { Icon: CODE, color: '#e8d44d' },
  cjs: { Icon: CODE, color: '#e8d44d' },

  json: { Icon: FileJson, color: '#cbcb41' },
  jsonc: { Icon: FileJson, color: '#cbcb41' },
  json5: { Icon: FileJson, color: '#cbcb41' },

  rs: { Icon: CODE, color: '#dea584' },
  py: { Icon: CODE, color: '#4b8bbe' },
  go: { Icon: CODE, color: '#00add8' },
  java: { Icon: Coffee, color: '#e76f00' },
  kt: { Icon: CODE, color: '#a97bff' },
  swift: { Icon: CODE, color: '#f05138' },
  rb: { Icon: CODE, color: '#cc342d' },
  php: { Icon: CODE, color: '#777bb4' },
  cs: { Icon: CODE, color: '#68217a' },
  c: { Icon: CODE, color: '#5f9fd6' },
  h: { Icon: CODE, color: '#5f9fd6' },
  cpp: { Icon: CODE, color: '#9c68d6' },
  cc: { Icon: CODE, color: '#9c68d6' },
  hpp: { Icon: CODE, color: '#9c68d6' },
  lua: { Icon: CODE, color: '#3d7fd6' },
  dart: { Icon: CODE, color: '#40c4ff' },

  html: { Icon: CODE, color: '#e34c26' },
  htm: { Icon: CODE, color: '#e34c26' },
  vue: { Icon: CODE, color: '#41b883' },
  svelte: { Icon: CODE, color: '#ff3e00' },
  xml: { Icon: CODE, color: '#8bc34a' },
  svg: { Icon: FileImage, color: '#ffb13b' },

  css: { Icon: Hash, color: '#8f6fd6' },
  scss: { Icon: Hash, color: '#cd6799' },
  sass: { Icon: Hash, color: '#cd6799' },
  less: { Icon: Hash, color: '#2b5e8f' },

  md: { Icon: FileType2, color: '#6aa9e0' },
  markdown: { Icon: FileType2, color: '#6aa9e0' },
  mdx: { Icon: FileType2, color: '#6aa9e0' },
  txt: { Icon: FileText, color: '#9aa0a6' },
  rst: { Icon: FileText, color: '#9aa0a6' },
  pdf: { Icon: FileText, color: '#e05a4e' },

  yml: { Icon: Settings2, color: '#cb4b4b' },
  yaml: { Icon: Settings2, color: '#cb4b4b' },
  toml: { Icon: Settings2, color: '#c98a4b' },
  ini: { Icon: Settings2, color: '#c98a4b' },
  cfg: { Icon: Settings2, color: '#c98a4b' },
  conf: { Icon: Settings2, color: '#c98a4b' },
  env: { Icon: FileLock2, color: '#d6b656' },

  sh: { Icon: SquareTerminal, color: '#89e051' },
  bash: { Icon: SquareTerminal, color: '#89e051' },
  zsh: { Icon: SquareTerminal, color: '#89e051' },
  fish: { Icon: SquareTerminal, color: '#89e051' },

  sql: { Icon: Database, color: '#e38c00' },
  db: { Icon: Database, color: '#e38c00' },
  sqlite: { Icon: Database, color: '#e38c00' },

  png: { Icon: FileImage, color: '#4fb8ad' },
  jpg: { Icon: FileImage, color: '#4fb8ad' },
  jpeg: { Icon: FileImage, color: '#4fb8ad' },
  gif: { Icon: FileImage, color: '#4fb8ad' },
  webp: { Icon: FileImage, color: '#4fb8ad' },
  ico: { Icon: FileImage, color: '#4fb8ad' },
  icns: { Icon: FileImage, color: '#4fb8ad' },

  woff: { Icon: Type, color: '#b06fd6' },
  woff2: { Icon: Type, color: '#b06fd6' },
  ttf: { Icon: Type, color: '#b06fd6' },
  otf: { Icon: Type, color: '#b06fd6' },

  zip: { Icon: FileArchive, color: '#c9a227' },
  gz: { Icon: FileArchive, color: '#c9a227' },
  tar: { Icon: FileArchive, color: '#c9a227' },
  dmg: { Icon: FileArchive, color: '#c9a227' },
  lock: { Icon: FileLock2, color: '#9aa0a6' },
}

const BY_NAME: Record<string, Spec> = {
  'package.json': { Icon: Braces, color: '#8bc34a' },
  'package-lock.json': { Icon: FileLock2, color: '#8f9aa6' },
  'cargo.toml': { Icon: Settings2, color: '#dea584' },
  'cargo.lock': { Icon: FileLock2, color: '#8f9aa6' },
  'tsconfig.json': { Icon: Braces, color: '#3178c6' },
  dockerfile: { Icon: CODE, color: '#2496ed' },
  makefile: { Icon: SquareTerminal, color: '#9aa0a6' },
  '.gitignore': { Icon: FileText, color: '#e8734a' },
  '.env': { Icon: FileLock2, color: '#d6b656' },
  'readme.md': { Icon: FileType2, color: '#6aa9e0' },
  'license': { Icon: FileText, color: '#d6b656' },
}

const DEFAULT: Spec = { Icon: FileText, color: 'var(--fg-subtle)' }

export function specFor(name: string): Spec {
  const lower = name.toLowerCase()
  if (BY_NAME[lower]) return BY_NAME[lower]
  if (lower.startsWith('dockerfile')) return BY_NAME.dockerfile
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return BY_EXT[ext] ?? DEFAULT
}

export function FileIcon({
  name, size = 13, className,
}: { name: string; size?: number; className?: string }) {
  const { Icon, color } = specFor(name)
  return <Icon size={size} className={className} style={{ color }} />
}

export function DirIcon({
  open, size = 13,
}: { open?: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder
  return <Icon size={size} style={{ color: 'var(--blue)' }} />
}
