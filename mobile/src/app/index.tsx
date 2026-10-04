import { useEffect } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

import { useConnection } from '../lib/connection'
import { usePalette } from '../lib/theme'
import { Button, Row, SectionTitle } from '../components/ui'

/** Only on launch: coming back here later is a choice to switch. */
let launched = false

/** The computers this device is paired with. */
export default function Computers() {
  const p = usePalette()
  const desktops = useConnection((s) => s.desktops)
  const open = useConnection((s) => s.open)
  const forget = useConnection((s) => s.forget)

  // With a single computer there is nothing to choose: go straight to it.
  useEffect(() => {
    if (launched) return
    launched = true
    if (desktops.length === 1) {
      open(desktops[0].id)
      router.push('/session')
    }
  }, [desktops, open])

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Ionicons name="add" size={26} color={p.fg} onPress={() => router.push('/pair')} />
          ),
        }}
      />
      {desktops.length === 0 ? (
        <View style={styles.welcome}>
          <Ionicons name="desktop-outline" size={56} color={p.accent} />
          <Text style={[styles.h1, { color: p.fg }]}>Control AlmaStudio from here</Text>
          <Text style={[styles.lead, { color: p.muted }]}>
            Your agents and terminals keep running on the computer. This app shows them, lets you
            type into them and tells you when one needs you.
          </Text>
          <Text style={[styles.lead, { color: p.muted }]}>
            On the computer, open Settings → Companion app, turn it on and choose “Pair a device…”.
          </Text>
          <Button title="Scan the pairing code" onPress={() => router.push('/pair')} />
        </View>
      ) : (
        <>
          <SectionTitle>Paired computers</SectionTitle>
          {desktops.map((d) => (
            <Row
              key={d.id}
              title={d.name}
              subtitle={
                d.lastConnectedAt
                  ? `Last connected ${new Date(d.lastConnectedAt).toLocaleString()}`
                  : d.addresses[0] ?? 'Through the relay'
              }
              left={<Ionicons name="desktop-outline" size={22} color={p.accent} />}
              chevron
              onPress={() => {
                open(d.id)
                router.push('/session')
              }}
              onLongPress={() =>
                Alert.alert(d.name, 'Forget this computer? You will need to pair again.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Forget', style: 'destructive', onPress: () => void forget(d.id) },
                ])
              }
            />
          ))}
        </>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  welcome: { padding: 28, paddingTop: 60, gap: 16, alignItems: 'center' },
  h1: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  lead: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
