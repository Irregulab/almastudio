/** Reads what a Claude tab's SessionStart hook recorded; see `ClaudeSession`. */

import { pathExists, readTextFile, stateDirPath } from './ipc'
import { claudeSessionFile, type ClaudeSession } from './harness'

let stateDir: Promise<string> | null = null

const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,}$/i

/** Where a Claude tab's hook writes, and — when resuming — what it last recorded. */
export async function claudeSessionFor(tabId: string, resume: boolean): Promise<ClaudeSession> {
  stateDir ??= stateDirPath().catch((e) => {
    stateDir = null
    throw e
  })
  const file = claudeSessionFile(await stateDir, tabId)
  if (!resume) return { file, recorded: 'none' }

  try {
    const record = JSON.parse((await readTextFile(file)).content) as {
      session_id?: unknown
      transcript_path?: unknown
    }
    const id = typeof record.session_id === 'string' ? record.session_id : ''
    if (!SESSION_ID.test(id)) return { file, recorded: 'none' }
    // A session that never got a first message has no transcript, and Claude
    // cannot resume it.
    if (typeof record.transcript_path === 'string' && !(await pathExists(record.transcript_path))) {
      return { file, recorded: 'gone' }
    }
    return { file, recorded: { sessionId: id } }
  } catch {
    // No record yet: a tab from before this existed, or one never started.
    return { file, recorded: 'none' }
  }
}
