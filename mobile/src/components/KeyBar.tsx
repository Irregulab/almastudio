import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Ionicons } from '@expo/vector-icons'

import { usePalette } from '../lib/theme'

/** Keys a phone keyboard lacks, as the bytes a terminal sends for them. */
const KEYS: Array<{ label: string; seq?: string; icon?: keyof typeof Ionicons.glyphMap; ctrl?: true }> = [
  { label: 'esc', seq: '\x1b' },
  { label: 'ctrl', ctrl: true },
  { label: 'tab', seq: '\t' },
  { label: '⇧tab', seq: '\x1b[Z' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '/', seq: '/' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '-', seq: '-' },
]

interface Props {
  ctrl: boolean
  onCtrl: () => void
  onKey: (seq: string) => void
  onCompose: () => void
  /** The soft keyboard is up: the button then puts it away. */
  keyboardOpen: boolean
  onKeyboard: () => void
  onEnter: () => void
}

export function KeyBar({ ctrl, onCtrl, onKey, onCompose, keyboardOpen, onKeyboard, onEnter }: Props) {
  const p = usePalette()
  const tap = (fn: () => void) => () => {
    void Haptics.selectionAsync().catch(() => {})
    fn()
  }
  return (
    <View style={[styles.bar, { backgroundColor: p.panel, borderTopColor: p.border }]}>
      <Pressable
        style={styles.icon}
        onPress={tap(onKeyboard)}
        accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
      >
        <Ionicons
          name={keyboardOpen ? 'chevron-down' : 'keypad-outline'}
          size={keyboardOpen ? 20 : 18}
          color={keyboardOpen ? p.accent : p.muted}
        />
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.keys}
      >
        {KEYS.map((k) => {
          const on = k.ctrl && ctrl
          return (
            <Pressable
              key={k.label}
              onPress={tap(() => (k.ctrl ? onCtrl() : onKey(k.seq!)))}
              style={({ pressed }) => [
                styles.key,
                { borderColor: p.border, backgroundColor: on ? p.accent : pressed ? p.raised : 'transparent' },
              ]}
            >
              <Text style={[styles.label, { color: on ? p.accentFg : p.fg }]}>{k.label}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      <Pressable style={styles.icon} onPress={tap(onCompose)} accessibilityLabel="Write a prompt">
        <Ionicons name="create-outline" size={19} color={p.muted} />
      </Pressable>
      <Pressable style={styles.icon} onPress={tap(onEnter)} accessibilityLabel="Enter">
        <Ionicons name="return-down-back" size={19} color={p.accent} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  keys: { gap: 6, paddingHorizontal: 4, alignItems: 'center' },
  key: {
    minWidth: 38,
    height: 34,
    paddingHorizontal: 8,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 14, fontFamily: 'Menlo' },
  icon: { width: 40, height: 34, alignItems: 'center', justifyContent: 'center' },
})
