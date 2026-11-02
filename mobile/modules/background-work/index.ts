import { requireOptionalNativeModule } from 'expo'

/** iOS only; see ios/BackgroundWorkModule.swift. */
const native = requireOptionalNativeModule<{ finish(): void }>('BackgroundWork')

/**
 * Gives back the background time iOS granted for answering a notification
 * action, so the app can be suspended again. A no-op elsewhere.
 */
export function finishBackgroundWork() {
  try {
    native?.finish()
  } catch {
    /* nothing held */
  }
}
