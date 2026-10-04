import { describe, expect, it } from 'vitest'

import { relayClientUrl, relayRoom } from './relay'

describe('relay', () => {
  // The same vector is checked by room_of in the desktop and in the relay.
  it('names a desktop room as the desktop and the relay do', () => {
    expect(relayRoom(new Uint8Array(32).fill(1))).toBe('zTRx9g6V1lbAUoRsCUzp0RaB2ZKc15yk')
  })

  it('builds the client address without doubled slashes', () => {
    expect(relayClientUrl('wss://relay.example/', new Uint8Array(32).fill(1))).toBe(
      'wss://relay.example/v1/client/zTRx9g6V1lbAUoRsCUzp0RaB2ZKc15yk',
    )
  })
})
