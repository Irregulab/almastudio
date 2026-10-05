import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Appearance, StyleSheet, Text, View, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as LocalAuthentication from 'expo-local-authentication'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '../lib/random'
import { useConnection } from '../lib/connection'
import { usePalette } from '../lib/theme'
import { Button } from '../components/ui'
import { useNotifications } from '../lib/notifications'

/** Away for longer than this, the app asks for Face ID again. */
const LOCK_AFTER_MS = 30_000

export default function RootLayout() {
  const p = usePalette()
  const scheme = useColorScheme()
  const booted = useConnection((s) => s.booted)
  const biometric = useConnection((s) => s.prefs.biometric)
  const theme = useConnection((s) => s.prefs.theme)
  const [locked, setLocked] = useState(true)
  const lockedRef = useRef(true)
  const authenticating = useRef(false)
  const backgroundAt = useRef<number | null>(null)

  useEffect(() => {
    void useConnection.getState().boot()
  }, [])
  useNotifications()

  // Dark or light for the whole app — colours, terminal, status bar, and the
  // system's own alerts and keyboard — or back to following the system.
  useEffect(() => {
    Appearance.setColorScheme(theme === 'auto' ? 'unspecified' : theme)
  }, [theme])

  const setLock = useCallback((value: boolean) => {
    lockedRef.current = value
    setLocked(value)
  }, [])

  /**
   * Asks for Face ID once. The system sheet itself takes the app to
   * `inactive` and back to `active`, so this must neither run while a prompt
   * is up nor when the app is already unlocked — or every success would
   * start the next prompt.
   */
  const unlock = useCallback(async () => {
    if (authenticating.current || !lockedRef.current) return
    authenticating.current = true
    try {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock AlmaStudio' })
      if (r.success) setLock(false)
    } finally {
      authenticating.current = false
    }
  }, [setLock])

  // Optional lock: the terminals of a computer are worth a Face ID.
  useEffect(() => {
    if (!booted) return
    if (!biometric) {
      setLock(false)
      return
    }
    if (lockedRef.current) void unlock()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // Covered straight away, so the app switcher shows no terminal. A
        // lock that was already on stays on however short the trip.
        backgroundAt.current = lockedRef.current ? 0 : Date.now()
        setLock(true)
      } else if (state === 'active' && backgroundAt.current !== null) {
        // Only on coming back from the background: the Face ID sheet also
        // passes through `active`, and asking then — after a success or a
        // cancel — is what kept the prompt coming back.
        const away = Date.now() - backgroundAt.current
        backgroundAt.current = null
        if (away <= LOCK_AFTER_MS) setLock(false)
        else void unlock()
      }
    })
    return () => sub.remove()
  }, [booted, biometric, setLock, unlock])

  const header = {
    headerStyle: { backgroundColor: p.panel },
    headerTintColor: p.fg,
    headerTitleStyle: { color: p.fg },
    contentStyle: { backgroundColor: p.bg },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal' as const,
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      {!booted ? (
        <View style={[styles.fill, { backgroundColor: p.bg }]} />
      ) : (
        <Stack screenOptions={header}>
          <Stack.Screen name="index" options={{ title: 'Computers' }} />
          <Stack.Screen name="pair" options={{ title: 'Pair a computer', presentation: 'modal' }} />
          <Stack.Screen name="session" options={{ headerShown: false }} />
          <Stack.Screen name="projects" options={{ title: 'Projects' }} />
          <Stack.Screen name="new-tab" options={{ title: 'New tab' }} />
          <Stack.Screen name="files" options={{ title: 'Files' }} />
          <Stack.Screen name="file" options={{ title: 'File' }} />
          <Stack.Screen name="git" options={{ title: 'Git' }} />
          <Stack.Screen name="diff" options={{ title: 'Diff' }} />
          <Stack.Screen name="commit" options={{ title: 'Commit' }} />
          <Stack.Screen name="search" options={{ title: 'Search' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
      )}
      {/* Over the app rather than instead of it, so unlocking returns to the
          same screen and terminal with the connection still up. */}
      {booted && biometric && locked && (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: p.bg }]}>
          <Text style={{ color: p.muted, marginBottom: 16 }}>AlmaStudio is locked</Text>
          <Button title="Unlock" onPress={() => void unlock()} />
        </View>
      )}
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
})
