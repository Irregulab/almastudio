import * as Crypto from 'expo-crypto'

/** Cryptographically secure bytes, from the platform's generator. */
export const randomBytes = (n: number): Uint8Array => Crypto.getRandomBytes(n)

// @noble reaches for the Web Crypto API by default, which Hermes lacks.
const g = globalThis as { crypto?: { getRandomValues?: unknown } }
if (!g.crypto?.getRandomValues) {
  g.crypto = {
    ...(g.crypto ?? {}),
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      const bytes = Crypto.getRandomBytes(array.byteLength)
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
      return array
    },
  }
}
