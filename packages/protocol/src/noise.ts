/**
 * The app's side of Noise_IK_25519_ChaChaPoly_SHA256, matching `snow` on the
 * desktop (src-tauri/src/remote/noise.rs). Written against the Noise spec
 * (revision 34) with audited primitives from @noble, because no maintained
 * Noise library runs on React Native's Hermes without native modules.
 *
 * The app is always the initiator: it knows the desktop's static key from the
 * pairing QR code, sends `-> e, es, s, ss` with its hello, and reads
 * `<- e, ee, se` with the desktop's verdict.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { PROLOGUE } from './index'

const PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256'
const DHLEN = 32
const TAGLEN = 16
const MAX_NOISE_MSG = 65535
/** Plaintext per transport chunk: room for the flag byte and the tag. */
const CHUNK = MAX_NOISE_MSG - TAGLEN - 1
const MAX_MESSAGE = 32 * 1024 * 1024

const enc = new TextEncoder()

export type RandomBytes = (n: number) => Uint8Array

export interface KeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export function generateKeyPair(random?: RandomBytes): KeyPair {
  const privateKey = random ? random(32) : x25519.utils.randomSecretKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 96-bit ChaChaPoly nonce: four zero bytes, then the counter little-endian. */
function nonceOf(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, n, true)
  return nonce
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm)
  const out1 = hmac(sha256, temp, Uint8Array.of(1))
  const out2 = hmac(sha256, temp, concat(out1, Uint8Array.of(2)))
  return [out1, out2]
}

class CipherState {
  private n = 0n
  constructor(private k: Uint8Array | null = null) {}

  hasKey() {
    return this.k !== null
  }

  encrypt(ad: Uint8Array, plain: Uint8Array): Uint8Array {
    if (!this.k) return plain
    const out = chacha20poly1305(this.k, nonceOf(this.n), ad).encrypt(plain)
    this.n++
    return out
  }

  decrypt(ad: Uint8Array, cipher: Uint8Array): Uint8Array {
    if (!this.k) return cipher
    // Throws on a bad tag; the counter only moves on success, as the spec says.
    const out = chacha20poly1305(this.k, nonceOf(this.n), ad).decrypt(cipher)
    this.n++
    return out
  }
}

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  cipher = new CipherState()

  constructor() {
    const name = enc.encode(PROTOCOL)
    // The name is exactly HASHLEN long, so it is used as is, zero-padded.
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name)
    this.ck = this.h
  }

  mixHash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data))
  }

  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf2(this.ck, ikm)
    this.ck = ck
    this.cipher = new CipherState(k)
  }

  encryptAndHash(plain: Uint8Array): Uint8Array {
    const c = this.cipher.encrypt(this.h, plain)
    this.mixHash(c)
    return c
  }

  decryptAndHash(cipher: Uint8Array): Uint8Array {
    const p = this.cipher.decrypt(this.h, cipher)
    this.mixHash(cipher)
    return p
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0))
    return [new CipherState(k1), new CipherState(k2)]
  }
}

/** The initiator's handshake, in its two steps. */
export class Initiator {
  private ss = new SymmetricState()
  private e: KeyPair

  constructor(
    private s: KeyPair,
    private rs: Uint8Array,
    random?: RandomBytes,
  ) {
    this.ss.mixHash(enc.encode(PROLOGUE))
    // Pre-message pattern `<- s`.
    this.ss.mixHash(rs)
    this.e = generateKeyPair(random)
  }

  /** `-> e, es, s, ss` carrying `payload`. */
  writeFirst(payload: Uint8Array): Uint8Array {
    const ss = this.ss
    ss.mixHash(this.e.publicKey)
    ss.mixKey(x25519.getSharedSecret(this.e.privateKey, this.rs))
    const encS = ss.encryptAndHash(this.s.publicKey)
    ss.mixKey(x25519.getSharedSecret(this.s.privateKey, this.rs))
    const encPayload = ss.encryptAndHash(payload)
    return concat(this.e.publicKey, encS, encPayload)
  }

  /** `<- e, ee, se`; returns the payload and the transport channel. */
  readSecond(msg: Uint8Array): { payload: Uint8Array; channel: Channel } {
    if (msg.length < DHLEN + TAGLEN) throw new Error('handshake message too short')
    const ss = this.ss
    const re = msg.subarray(0, DHLEN)
    ss.mixHash(re)
    ss.mixKey(x25519.getSharedSecret(this.e.privateKey, re))
    ss.mixKey(x25519.getSharedSecret(this.s.privateKey, re))
    const payload = ss.decryptAndHash(msg.subarray(DHLEN))
    const [send, recv] = ss.split()
    return { payload, channel: new Channel(send, recv) }
  }
}

/**
 * Sealed transport, with messages split into chunks that carry a one-byte
 * flag: 1 while more of the same message follows, 0 on its last chunk.
 */
export class Channel {
  private partial: Uint8Array[] = []
  private partialLen = 0
  private static readonly EMPTY = new Uint8Array(0)

  constructor(
    private send: CipherState,
    private recv: CipherState,
  ) {}

  seal(plain: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = []
    if (plain.length === 0) {
      frames.push(this.send.encrypt(Channel.EMPTY, Uint8Array.of(0)))
      return frames
    }
    for (let at = 0; at < plain.length; at += CHUNK) {
      const chunk = plain.subarray(at, at + CHUNK)
      const more = at + CHUNK < plain.length ? 1 : 0
      frames.push(this.send.encrypt(Channel.EMPTY, concat(Uint8Array.of(more), chunk)))
    }
    return frames
  }

  /** The whole message once its last chunk is in, else null. */
  open(frame: Uint8Array): Uint8Array | null {
    const plain = this.recv.decrypt(Channel.EMPTY, frame)
    if (plain.length === 0) throw new Error('empty frame')
    const body = plain.subarray(1)
    if (this.partialLen + body.length > MAX_MESSAGE) throw new Error('message too large')
    this.partial.push(body)
    this.partialLen += body.length
    if (plain[0] === 1) return null
    const whole = this.partial.length === 1 ? this.partial[0] : concat(...this.partial)
    this.partial = []
    this.partialLen = 0
    return whole
  }
}

// ------------------------------------------------------------- base64url ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
  }
  return out
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let at = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new Error('invalid base64')
    value = (value << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

/** Standard base64, as the desktop sends terminal output. */
export function fromBase64(s: string): Uint8Array {
  return fromBase64Url(s.replace(/\+/g, '-').replace(/\//g, '_'))
}
