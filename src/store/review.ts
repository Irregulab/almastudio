import { create } from 'zustand'

import { stateLoad, stateSave } from '../lib/ipc'
import { emptyReview, type Review } from '../lib/review'

const STATE_KEY = 'reviews'

interface ReviewStore {
  /**
   * Reviews under way, by repository root. Kept apart from the tab showing
   * one, so closing the tab does not throw the comments away.
   */
  reviews: Record<string, Review>
  loaded: boolean
  update: (root: string, fn: (review: Review) => Review) => void
}

export const useReviews = create<ReviewStore>((set) => ({
  reviews: {},
  loaded: false,
  update: (root, fn) =>
    set((s) => ({ reviews: { ...s.reviews, [root]: fn(s.reviews[root] ?? emptyReview()) } })),
}))

export async function loadReviews(): Promise<void> {
  try {
    const raw = await stateLoad(STATE_KEY)
    useReviews.setState({ reviews: raw ? JSON.parse(raw) : {}, loaded: true })
  } catch {
    // A corrupt file costs the comments in it, never the startup.
    useReviews.setState({ loaded: true })
  }
}

let saveTimer: number | undefined

/** Debounced, as the workspace is: comments are written while they are typed. */
export function startReviewPersistence() {
  useReviews.subscribe((state, prev) => {
    if (!state.loaded || state.reviews === prev.reviews) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void stateSave(STATE_KEY, JSON.stringify(useReviews.getState().reviews)).catch(() => {})
    }, 400)
  })
}
