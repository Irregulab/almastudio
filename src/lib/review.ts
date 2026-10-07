/** A review of a repository's uncommitted changes, written for a harness to act on. */

import { t } from '../i18n'
import type { DiffLine, FileDiff } from './types'

/** `question` asks for an answer rather than a change; `nit` is worth fixing only if cheap. */
export type CommentKind = 'fix' | 'question' | 'nit'
export const COMMENT_KINDS: CommentKind[] = ['fix', 'question', 'nit']

export interface ReviewComment {
  id: string
  /** Repo-relative. */
  path: string
  /** The file `startLine` and `line` count in: the old one only for removed lines. */
  side: 'old' | 'new'
  startLine: number
  /** The last line commented on, which the comment is shown under. */
  line: number
  /** The lines as the diff showed them, signs included: they move once the file is edited. */
  code: string
  kind: CommentKind
  body: string
}

export interface Review {
  comments: ReviewComment[]
  /** A comment on the changes as a whole. */
  general: string
  /** Files marked as viewed, each with the signature of the diff it showed then. */
  viewed: Record<string, string>
}

export const emptyReview = (): Review => ({ comments: [], general: '', viewed: {} })

/** Where a diff line sits: in the new file, or in the old one when it was removed. */
export const lineAnchor = (l: DiffLine): Pick<ReviewComment, 'side' | 'line'> =>
  l.origin === '-'
    ? { side: 'old', line: l.oldLineno ?? 0 }
    : { side: 'new', line: l.newLineno ?? 0 }

/** Where a comment on a run of a hunk's lines goes: under the last of them. */
export function anchorLines(
  lines: DiffLine[],
): Pick<ReviewComment, 'side' | 'startLine' | 'line' | 'code'> {
  const anchors = lines.map(lineAnchor)
  const end = anchors[anchors.length - 1]
  return {
    ...end,
    // A run may start on a removed line and end on an added one; the range
    // is counted in the file the last line belongs to.
    startLine: anchors.find((a) => a.side === end.side)!.line,
    code: lines.map((l) => l.origin + l.content).join('\n'),
  }
}

/** Changes whenever the diff does, so a viewed mark does not outlive what was viewed. */
export function diffSignature(diff: FileDiff): string {
  let hash = 5381
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const text = line.origin + line.content
      for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) | 0
    }
  }
  return `${diff.additions}.${diff.deletions}.${hash}`
}

/** The review as the prompt a harness receives. */
export function formatReview(review: Review): string {
  const kinds = Object.fromEntries(COMMENT_KINDS.map((k) => [k, t(`review.kind.${k}`)]))
  const parts = [t('review.prompt.intro', kinds)]
  if (review.general.trim()) parts.push(`## ${t('review.general')}\n${review.general.trim()}`)

  const comments = [...review.comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
  )
  for (const c of comments) {
    const range = c.startLine === c.line ? `${c.line}` : `${c.startLine}-${c.line}`
    const removed = c.side === 'old' ? ` (${t('review.prompt.removed')})` : ''
    // Four backticks, so a fence in the quoted code does not close the block.
    parts.push(
      `### ${c.path}:${range}${removed} [${kinds[c.kind]}]\n` +
        `\`\`\`\`diff\n${c.code}\n\`\`\`\`\n${c.body}`,
    )
  }
  return parts.join('\n\n')
}
