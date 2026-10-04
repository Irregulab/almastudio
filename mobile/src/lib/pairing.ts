import { fromBase64Url } from '@almastudio/protocol/src/noise'
import { utf8Decode } from '@almastudio/protocol/src/client'
import type { PairingPayload } from '@almastudio/protocol'

/**
 * Reads a pairing link — `almastudio://pair?d=…`, as the desktop's QR code
 * holds — or just its `d` value. Null when it is not one.
 */
export function parsePairing(input: string): PairingPayload | null {
  const text = input.trim()
  let d = text
  const match = text.match(/[?&]d=([A-Za-z0-9_-]+)/)
  if (match) d = match[1]
  if (!/^[A-Za-z0-9_-]+$/.test(d)) return null
  try {
    const payload = JSON.parse(utf8Decode(fromBase64Url(d))) as PairingPayload
    if (payload.v !== 1 || typeof payload.k !== 'string' || typeof payload.t !== 'string') return null
    if (fromBase64Url(payload.k).length !== 32) return null
    return { ...payload, a: Array.isArray(payload.a) ? payload.a : [], r: payload.r ?? null }
  } catch {
    return null
  }
}
