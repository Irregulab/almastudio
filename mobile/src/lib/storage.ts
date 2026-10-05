import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

import { generateKeyPair, publicKeyOf, toBase64Url, fromBase64Url, type KeyPair } from '@almastudio/protocol/src/noise'
import { randomBytes } from './random'

/**
 * Everything the app keeps lives in the platform keychain: this device's
 * private key, and which desktops it is paired with.
 */

const DEVICE_KEY = 'almastudio.deviceKey'
const DESKTOPS = 'almastudio.desktops'
const PREFS = 'almastudio.prefs'

/** A desktop this device is paired with. */
export interface Desktop {
  /** The desktop's static public key, base64url; also its id. */
  id: string
  name: string
  /** `ip:port` on its local network, as last heard. */
  addresses: string[]
  relay: string | null
  pairedAt: number
  lastConnectedAt?: number
}

export type ThemeMode = 'auto' | 'dark' | 'light'

export interface Prefs {
  /** `auto` follows the system's appearance. */
  theme: ThemeMode
  fontSize: number
  /** `phone`: the terminal takes this screen's size; `desktop`: shows the desktop's width. */
  fitMode: 'phone' | 'desktop'
  /** The screen neither dims nor locks while the app is open. */
  keepAwake: boolean
  /** Ask for Face ID / fingerprint when the app opens. */
  biometric: boolean
  /** Send notifications through Apple and Google when an agent needs you. */
  notifications: boolean
}

/** Tablets have the room for a terminal that reads like the desktop's. */
const isTablet = Platform.OS === 'ios' ? Platform.isPad : false

export const DEFAULT_PREFS: Prefs = {
  theme: 'auto',
  fontSize: isTablet ? 14 : 12,
  fitMode: 'phone',
  keepAwake: false,
  biometric: false,
  notifications: true,
}

let cachedKey: KeyPair | null = null

/** This device's identity, created on first use. */
export async function deviceKeyPair(): Promise<KeyPair> {
  if (cachedKey) return cachedKey
  const stored = await SecureStore.getItemAsync(DEVICE_KEY)
  if (stored) {
    const privateKey = fromBase64Url(stored)
    cachedKey = { privateKey, publicKey: publicKeyOf(privateKey) }
    return cachedKey
  }
  const pair = generateKeyPair(randomBytes)
  await SecureStore.setItemAsync(DEVICE_KEY, toBase64Url(pair.privateKey), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  })
  cachedKey = pair
  return pair
}

export async function loadDesktops(): Promise<Desktop[]> {
  try {
    const raw = await SecureStore.getItemAsync(DESKTOPS)
    return raw ? (JSON.parse(raw) as Desktop[]) : []
  } catch {
    return []
  }
}

export async function saveDesktops(desktops: Desktop[]): Promise<void> {
  await SecureStore.setItemAsync(DESKTOPS, JSON.stringify(desktops))
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await SecureStore.getItemAsync(PREFS)
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await SecureStore.setItemAsync(PREFS, JSON.stringify(prefs))
}
