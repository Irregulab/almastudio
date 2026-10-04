/**
 * A connection to a desktop: the WebSocket, the Noise handshake on top, then
 * requests, events and a keep-alive. Shared by the mobile app and the smoke
 * test, so it only uses what both have: the standard WebSocket API.
 */

import type {
  EventName, Events, Hello, Method, Methods, ServerMessage, Welcome,
} from './index'
import { Channel, Initiator, type KeyPair, type RandomBytes } from './noise'

const PING_EVERY_MS = 15_000
const DEAD_AFTER_MS = 40_000
const REQUEST_TIMEOUT_MS = 30_000

export interface ConnectOptions {
  /** Where the desktop may be: LAN addresses first, then the relay. */
  urls: string[]
  desktopKey: Uint8Array
  keyPair: KeyPair
  hello: Hello
  random?: RandomBytes
  /** How long to wait for the desktop's answer. Pairing waits for a person. */
  handshakeTimeoutMs?: number
  WebSocketImpl?: typeof WebSocket
}

export class ConnectError extends Error {
  constructor(
    message: string,
    /** The desktop's own reason, when it gave one. */
    public readonly reason?: string,
  ) {
    super(message)
  }
}

const encoder = new TextEncoder()
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s)
}

export function utf8Decode(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]
    let cp: number
    if (b < 0x80) cp = b
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    else {
      cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
    }
    out += String.fromCodePoint(cp)
  }
  return out
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/** One attempt: open the socket and run the handshake. */
function attempt(url: string, opts: ConnectOptions): {
  promise: Promise<{ ws: WebSocket; channel: Channel; welcome: Welcome }>
  cancel: () => void
} {
  const WS = opts.WebSocketImpl ?? WebSocket
  let ws: WebSocket | null = null
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<{ ws: WebSocket; channel: Channel; welcome: Welcome }>(
    (resolve, reject) => {
      const fail = (err: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          ws?.close()
        } catch {
          /* already closed */
        }
        reject(err)
      }
      timer = setTimeout(
        () => fail(new ConnectError(`timed out: ${url}`)),
        opts.handshakeTimeoutMs ?? 10_000,
      )
      try {
        ws = new WS(url)
      } catch (e) {
        fail(new ConnectError(String(e)))
        return
      }
      ws.binaryType = 'arraybuffer'
      const ini = new Initiator(opts.keyPair, opts.desktopKey, opts.random)
      ws.onopen = () => {
        try {
          ws!.send(toArrayBuffer(ini.writeFirst(utf8Encode(JSON.stringify(opts.hello)))))
        } catch (e) {
          fail(new ConnectError(String(e)))
        }
      }
      ws.onmessage = (ev) => {
        if (done) return
        const bytes = asBytes(ev.data)
        if (!bytes) return
        try {
          const { payload, channel } = ini.readSecond(bytes)
          const welcome = JSON.parse(utf8Decode(payload)) as Welcome
          if (!welcome.ok) {
            fail(new ConnectError(welcome.error ?? 'refused', welcome.error))
            return
          }
          done = true
          clearTimeout(timer)
          ws!.onmessage = null
          ws!.onerror = null
          ws!.onclose = null
          resolve({ ws: ws!, channel, welcome })
        } catch {
          // The desktop answered with a key other than the one paired.
          fail(new ConnectError('handshake failed', 'bad-key'))
        }
      }
      ws.onerror = () => fail(new ConnectError(`cannot reach ${url}`))
      ws.onclose = () => fail(new ConnectError(`closed: ${url}`))
    },
  )
  return {
    promise,
    cancel: () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** How telling a failure is; the most telling one is reported. */
const RANK: Record<string, number> = {
  denied: 5, 'not-paired': 4, 'bad-key': 3, 'invalid-code': 2,
}

type Handler = (data: never) => void

export class RemoteConnection {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private handlers = new Map<string, Set<Handler>>()
  private closeHandlers = new Set<(reason: string) => void>()
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private lastIn = Date.now()
  private closed = false

  private constructor(
    private ws: WebSocket,
    private channel: Channel,
    public readonly welcome: Welcome,
    /** The address that answered first. */
    public readonly url: string,
  ) {
    ws.onmessage = (ev) => this.receive(ev.data)
    ws.onclose = () => this.shutdown('closed')
    ws.onerror = () => this.shutdown('error')
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastIn > DEAD_AFTER_MS) {
        this.shutdown('timeout')
        return
      }
      this.send({ t: 'ping' })
    }, PING_EVERY_MS)
  }

  /**
   * Tries every address at once and keeps the first that completes the
   * handshake. Fails only when all of them have.
   */
  static connect(opts: ConnectOptions): Promise<RemoteConnection> {
    if (opts.urls.length === 0) return Promise.reject(new ConnectError('no address'))
    return new Promise((resolve, reject) => {
      const attempts = opts.urls.map((url) => ({ url, ...attempt(url, opts) }))
      let failures: ConnectError[] = []
      let won = false
      for (const a of attempts) {
        a.promise.then(
          ({ ws, channel, welcome }) => {
            if (won) {
              ws.close()
              return
            }
            won = true
            for (const other of attempts) if (other !== a) other.cancel()
            resolve(new RemoteConnection(ws, channel, welcome, a.url))
          },
          (err: ConnectError) => {
            failures = [...failures, err]
            if (!won && failures.length === attempts.length) {
              failures.sort((x, y) => (RANK[y.reason ?? ''] ?? 0) - (RANK[x.reason ?? ''] ?? 0))
              reject(failures[0])
            }
          },
        )
      }
    })
  }

  request<M extends Method>(method: M, params: Methods[M]['p']): Promise<Methods[M]['r']> {
    if (this.closed) return Promise.reject(new Error('disconnected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.send({ t: 'req', id, m: method, p: params })
    })
  }

  on<E extends EventName>(event: E, cb: (data: Events[E]) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(cb as Handler)
    return () => set!.delete(cb as Handler)
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeHandlers.add(cb)
    return () => this.closeHandlers.delete(cb)
  }

  get isClosed() {
    return this.closed
  }

  close() {
    this.shutdown('closed by app')
  }

  private send(msg: unknown) {
    if (this.closed) return
    try {
      for (const frame of this.channel.seal(utf8Encode(JSON.stringify(msg)))) {
        this.ws.send(toArrayBuffer(frame))
      }
    } catch {
      this.shutdown('send failed')
    }
  }

  private receive(data: unknown) {
    const bytes = asBytes(data)
    if (!bytes || this.closed) return
    this.lastIn = Date.now()
    let plain: Uint8Array | null
    try {
      plain = this.channel.open(bytes)
    } catch {
      this.shutdown('bad frame')
      return
    }
    if (!plain) return
    const msg = JSON.parse(utf8Decode(plain)) as ServerMessage
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.r)
      else p.reject(new Error(msg.e))
    } else if (msg.t === 'ev') {
      for (const cb of this.handlers.get(msg.e) ?? []) {
        try {
          ;(cb as (d: unknown) => void)(msg.d)
        } catch {
          /* a handler's failure is its own */
        }
      }
    }
  }

  private shutdown(reason: string) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pingTimer)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('disconnected'))
    }
    this.pending.clear()
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
    for (const cb of this.closeHandlers) cb(reason)
  }
}
