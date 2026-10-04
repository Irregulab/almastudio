import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router, useLocalSearchParams } from 'expo-router'

import { useConnection } from '../lib/connection'
import { parsePairing } from '../lib/pairing'
import { usePalette } from '../lib/theme'
import { Button, Message } from '../components/ui'

/**
 * Pairs with a computer from its QR code — scanned here, or opened as an
 * `almastudio://pair` link — or from the link pasted in.
 */
export default function Pair() {
  const p = usePalette()
  const params = useLocalSearchParams<{ d?: string }>()
  const pair = useConnection((s) => s.pair)
  const [permission, requestPermission] = useCameraPermissions()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handled = useRef<string | null>(null)

  const start = async (input: string) => {
    if (busy || handled.current === input) return
    handled.current = input
    const payload = parsePairing(input)
    if (!payload) {
      setError('That is not an AlmaStudio pairing code.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await pair(payload)
      router.dismissAll()
      router.push('/session')
    } catch (e) {
      setError(String((e as Error).message ?? e))
      handled.current = null
    } finally {
      setBusy(false)
    }
  }

  // Opened from the link in the QR code.
  useEffect(() => {
    if (params.d) void start(`almastudio://pair?d=${params.d}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.d])

  if (busy) {
    return (
      <View style={[styles.center, { backgroundColor: p.bg }]}>
        <ActivityIndicator size="large" color={p.accent} />
        <Text style={[styles.wait, { color: p.fg }]}>Allow this device on the computer</Text>
        <Text style={{ color: p.muted, textAlign: 'center' }}>
          AlmaStudio is asking there whether to let it in.
        </Text>
      </View>
    )
  }

  return (
    <View style={[styles.fill, { backgroundColor: p.bg }]}>
      <View style={styles.camera}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => void start(data)}
          />
        ) : (
          <View style={[styles.center, { backgroundColor: p.panel }]}>
            <Text style={{ color: p.muted, marginBottom: 12, textAlign: 'center' }}>
              Scan the code shown in AlmaStudio → Settings → Companion app.
            </Text>
            <Button title="Allow the camera" onPress={() => void requestPermission()} />
          </View>
        )}
      </View>
      {error && <Message tone="error">{error}</Message>}
      <View style={styles.paste}>
        <Text style={{ color: p.muted }}>Or paste the pairing link</Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="almastudio://pair?d=…"
          placeholderTextColor={p.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: p.fg, borderColor: p.border, backgroundColor: p.panel }]}
          onSubmitEditing={() => void start(link)}
        />
        <Button title="Pair" kind="plain" disabled={!link} onPress={() => void start(link)} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  wait: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  camera: { aspectRatio: 1, margin: 20, borderRadius: 18, overflow: 'hidden' },
  paste: { paddingHorizontal: 20, gap: 10 },
  input: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 14 },
})
