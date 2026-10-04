import { create } from 'zustand'
import type { PairRequest, RemoteStatus } from '../lib/ipc'
import type { TerminalSize } from '../../packages/protocol/src'

/** A start a remote client asked for, waiting for the tab's terminal. */
export interface RemoteStart extends TerminalSize {
  /** `open`: a new tab, which starts by itself once it has a size. */
  mode: 'open' | 'start' | 'restart'
  /** Tells two requests for the same tab apart. */
  nonce: number
}

/** Remote access state — never persisted; settings hold the configuration. */
interface RemoteState {
  status: RemoteStatus | null
  /** Devices waiting for the user to allow them, oldest first. */
  pairRequests: PairRequest[]
  starts: Record<string, RemoteStart>
  setStatus: (status: RemoteStatus) => void
  addPairRequest: (r: PairRequest) => void
  removePairRequest: (requestId: number) => void
  requestStart: (tabId: string, start: Omit<RemoteStart, 'nonce'>) => void
  /** Drops the start for `tabId`, unless a newer one has replaced it. */
  consumeStart: (tabId: string, nonce: number) => void
}

let nonce = 0

export const useRemote = create<RemoteState>((set, get) => ({
  status: null,
  pairRequests: [],
  starts: {},
  setStatus: (status) => set({ status }),
  addPairRequest: (r) =>
    set((s) => ({ pairRequests: [...s.pairRequests.filter((p) => p.requestId !== r.requestId), r] })),
  removePairRequest: (requestId) =>
    set((s) => ({ pairRequests: s.pairRequests.filter((p) => p.requestId !== requestId) })),
  requestStart: (tabId, start) =>
    set((s) => ({ starts: { ...s.starts, [tabId]: { ...start, nonce: ++nonce } } })),
  consumeStart: (tabId, nonce) => {
    if (get().starts[tabId]?.nonce !== nonce) return
    set((s) => {
      const starts = { ...s.starts }
      delete starts[tabId]
      return { starts }
    })
  },
}))
