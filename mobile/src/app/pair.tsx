import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View,
  useWindowDimensions,
} from 'react-native'
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
  const { width } = useWindowDimensions()
  // As large as the screen allows, but no larger than a code needs on a tablet.
  const side = Math.min(width - 48, 360)

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
    <KeyboardAvoidingView
      style={[styles.fill, { backgroundColor: p.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.camera, { width: side, height: side, backgroundColor: p.panel }]}>
          {permission?.granted ? (
            <>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => void start(data)}
              />
              <Frame color={p.accent} />
            </>
          ) : (
            <View style={styles.center}>
              <Text style={{ color: p.muted, marginBottom: 12, textAlign: 'center' }}>
                AlmaStudio needs the camera to read the pairing code.
              </Text>
              <Button title="Allow the camera" onPress={() => void requestPermission()} />
            </View>
          )}
        </View>
        <Text style={[styles.hint, { color: p.muted, maxWidth: side }]}>
          On the computer: Settings → Companion app → Pair a device. Point the camera at the code.
        </Text>
        {error && <Message tone="error">{error}</Message>}
        <View style={[styles.paste, { width: side }]}>
          <Text style={{ color: p.subtle, textAlign: 'center' }}>Or paste the pairing link</Text>
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
          {link ? <Button title="Pair" kind="plain" onPress={() => void start(link)} /> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** Corner marks showing where the code should sit. */
function Frame({ color }: { color: string }) {
  const corner = (pos: object) => (
    <View style={[styles.corner, { borderColor: color }, pos]} />
  )
  return (
    <View style={styles.frame} pointerEvents="none">
      {corner({ top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 })}
      {corner({ top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 })}
      {corner({ bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 })}
      {corner({ bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 })}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Centred on the screen, both ways; scrolls only when the keyboard is up.
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  wait: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  camera: { borderRadius: 22, overflow: 'hidden' },
  frame: { position: 'absolute', top: '15%', left: '15%', right: '15%', bottom: '15%' },
  corner: { position: 'absolute', width: 34, height: 34 },
  hint: { textAlign: 'center', lineHeight: 20 },
  paste: { gap: 10 },
  input: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 14 },
})
