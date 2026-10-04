/**
 * Addresses on the relay. A desktop's room is derived from its public key, so
 * the app can find it with nothing more than the pairing QR code gave it, and
 * the relay learns nothing it could not already see.
 */

import { sha256 } from '@noble/hashes/sha2.js'

import { toBase64Url } from './noise'

const ROOM_CONTEXT = new TextEncoder().encode('almastudio-room-v1')

export function relayRoom(desktopKey: Uint8Array): string {
  const input = new Uint8Array(ROOM_CONTEXT.length + desktopKey.length)
  input.set(ROOM_CONTEXT)
  input.set(desktopKey, ROOM_CONTEXT.length)
  return toBase64Url(sha256(input)).slice(0, 32)
}

const base = (relay: string) => relay.replace(/\/+$/, '')

/** Where the app connects to reach a desktop through the relay. */
export function relayClientUrl(relay: string, desktopKey: Uint8Array): string {
  return `${base(relay)}/v1/client/${relayRoom(desktopKey)}`
}
