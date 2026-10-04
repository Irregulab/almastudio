import { describe, expect, it } from 'vitest'

import vectors from './noise-vectors.json'
import { Initiator, fromBase64Url, generateKeyPair, publicKeyOf, toBase64Url } from './noise'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const text = (s: string) => new TextEncoder().encode(s)

describe('noise', () => {
  // The vectors come from `snow`, the desktop's implementation; see
  // matches_the_vectors_the_app_is_tested_against in noise.rs.
  it('produces the same handshake and transport bytes as the desktop', () => {
    const phone = { privateKey: hex(vectors.phonePrivate), publicKey: publicKeyOf(hex(vectors.phonePrivate)) }
    const deskPublic = publicKeyOf(hex(vectors.deskPrivate))
    const ini = new Initiator(phone, deskPublic, () => hex(vectors.phoneEphemeral))

    expect(toHex(ini.writeFirst(text('{"name":"test"}')))).toBe(vectors.msg1)
    const { payload, channel } = ini.readSecond(hex(vectors.msg2))
    expect(new TextDecoder().decode(payload)).toBe('{"ok":true}')

    const up = channel.seal(text('ping'))
    expect(up).toHaveLength(1)
    expect(toHex(up[0])).toBe(vectors.up)
    expect(new TextDecoder().decode(channel.open(hex(vectors.down))!)).toBe('pong')
  })

  it('rejects a second message that was tampered with', () => {
    const phone = generateKeyPair()
    const ini = new Initiator(phone, publicKeyOf(hex(vectors.deskPrivate)))
    ini.writeFirst(text('x'))
    const bad = hex(vectors.msg2)
    bad[40] ^= 1
    expect(() => ini.readSecond(bad)).toThrow()
  })

  it('round-trips base64url', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff)
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    }
  })
})
