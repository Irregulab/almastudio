import { useEffect, useState } from 'react'
import { AppState, StyleSheet, Text, View, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as LocalAuthentication from 'expo-local-authentication'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '../lib/random'
import { useConnection } from '../lib/connection'
import { usePalette } from '../lib/theme'
import { Button } from '../components/ui'
import { useNotifications } from '../lib/notifications'

export default function RootLayout() {
  const p = usePalette()
  const scheme = useColorScheme()
  const booted = useConnection((s) => s.booted)
  const biometric = useConnection((s) => s.prefs.biometric)
  const [locked, setLocked] = useState(true)

  useEffect(() => {
    void useConnection.getState().boot()
  }, [])
  useNotifications()

  // Optional lock: the terminals of a computer are worth a Face ID.
  useEffect(() => {
    if (!booted) return
    if (!biometric) {
      setLocked(false)
      return
    }
    const unlock = () =>
      void LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock AlmaStudio' }).then((r) =>
        setLocked(!r.success),
      )
    unlock()
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') setLocked(true)
      if (s === 'active') unlock()
    })
    return () => sub.remove()
  }, [booted, biometric])

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
      ) : locked && biometric ? (
        <View style={[styles.fill, styles.center, { backgroundColor: p.bg }]}>
          <Text style={{ color: p.muted, marginBottom: 16 }}>AlmaStudio is locked</Text>
          <Button
            title="Unlock"
            onPress={() =>
              void LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock AlmaStudio' }).then(
                (r) => setLocked(!r.success),
              )
            }
          />
        </View>
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
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
})
