import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { router } from 'expo-router'

import { useConnection } from '../lib/connection'
import { pushProjectId } from '../lib/notifications'
import { usePalette } from '../lib/theme'
import type { ThemeMode } from '../lib/storage'
import { Row, SectionTitle } from '../components/ui'

/** App settings, and the way back to the list of computers. */
export default function Settings() {
  const p = usePalette()
  const prefs = useConnection((s) => s.prefs)
  const setPrefs = useConnection((s) => s.setPrefs)
  const close = useConnection((s) => s.close)
  const desktop = useConnection((s) => s.desktops.find((d) => d.id === s.activeId))
  const route = useConnection((s) => s.route)
  const status = useConnection((s) => s.status)

  return (
    <ScrollView style={{ backgroundColor: p.bg }}>
      <SectionTitle>Computer</SectionTitle>
      <Row
        title={desktop?.name ?? '—'}
        subtitle={
          status === 'online'
            ? route === 'relay' ? 'Connected through the relay' : 'Connected on the local network'
            : 'Not connected'
        }
      />
      <Row
        title="Switch computer"
        chevron
        onPress={() => {
          close()
          router.dismissAll()
        }}
      />

      <SectionTitle>Appearance</SectionTitle>
      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <Text style={[styles.label, { color: p.fg }]}>Theme</Text>
        <View style={[styles.segments, { backgroundColor: p.panel, borderColor: p.border }]}>
          {THEMES.map(({ value, label }) => {
            const on = prefs.theme === value
            return (
              <Pressable
                key={value}
                onPress={() => setPrefs({ theme: value })}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.segment, on && { backgroundColor: p.accent }]}
              >
                <Text style={{ color: on ? p.accentFg : p.fg, fontWeight: on ? '600' : '400' }}>
                  {label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      <SectionTitle>Terminal</SectionTitle>
      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <Text style={[styles.label, { color: p.fg }]}>Text size</Text>
        <View style={styles.stepper}>
          {[-1, 1].map((d) => (
            <Text
              key={d}
              onPress={() => setPrefs({ fontSize: Math.max(8, Math.min(22, prefs.fontSize + d)) })}
              style={[styles.step, { color: p.fg, borderColor: p.border }]}
            >
              {d < 0 ? 'A−' : 'A+'}
            </Text>
          ))}
          <Text style={{ color: p.muted, width: 28, textAlign: 'right' }}>{prefs.fontSize}</Text>
        </View>
      </View>
      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: p.fg }]}>Keep the desktop's width</Text>
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 2 }}>
            Shrinks the text instead of resizing the terminal for this screen.
          </Text>
        </View>
        <Switch
          value={prefs.fitMode === 'desktop'}
          onValueChange={(v) => setPrefs({ fitMode: v ? 'desktop' : 'phone' })}
        />
      </View>

      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: p.fg }]}>Keep the screen on</Text>
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 2 }}>
            The screen stays bright and unlocked while AlmaStudio is open.
          </Text>
        </View>
        <Switch value={prefs.keepAwake} onValueChange={(v) => setPrefs({ keepAwake: v })} />
      </View>

      <SectionTitle>Security</SectionTitle>
      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <Text style={[styles.label, { color: p.fg, flex: 1 }]}>Require Face ID / fingerprint</Text>
        <Switch value={prefs.biometric} onValueChange={(v) => setPrefs({ biometric: v })} />
      </View>

      <SectionTitle>Notifications</SectionTitle>
      <View style={[styles.item, { borderBottomColor: p.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: p.fg }]}>When an agent needs me</Text>
          <Text style={{ color: p.muted, fontSize: 12.5, marginTop: 2 }}>
            {pushProjectId()
              ? 'Delivered through Apple or Google while the app is closed.'
              : 'Shown while the app is open. Push needs the app built with its EAS project.'}
          </Text>
        </View>
        <Switch
          value={prefs.notifications}
          onValueChange={(v) => {
            setPrefs({ notifications: v })
            if (!v) Alert.alert('Notifications off', 'This device will no longer be notified.')
          }}
        />
      </View>
    </ScrollView>
  )
}

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { fontSize: 15.5 },
  segments: {
    flexDirection: 'row',
    marginLeft: 'auto',
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
  },
  segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  step: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
})
