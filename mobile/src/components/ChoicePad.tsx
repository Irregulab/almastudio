import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Ionicons } from '@expo/vector-icons'

import { usePalette } from '../lib/theme'
import type { Choice } from './TerminalPane'

export const ARROW = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const

interface Props {
  /** The menu on screen, when one was read off it; the keys work without. */
  choice: Choice | null
  onKey: (seq: string) => void
  /** Moves the highlight to an option, one arrow press at a time. */
  onPick: (index: number) => void
  onClose: () => void
}

/**
 * Arrow keys big enough to steer an agent's menu — a permission prompt, a
 * question with options — and Enter to choose. Shown when a menu is up, or
 * on request from the key bar.
 */
export function ChoicePad({ choice, onKey, onPick, onClose }: Props) {
  const p = usePalette()
  const tap = (fn: () => void) => () => {
    void Haptics.selectionAsync().catch(() => {})
    fn()
  }
  const key = (seq: string, icon: keyof typeof Ionicons.glyphMap, label: string) => (
    <Pressable
      key={label}
      onPress={tap(() => onKey(seq))}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.key,
        { borderColor: p.border, backgroundColor: pressed ? p.raised : p.bg },
      ]}
    >
      <Ionicons name={icon} size={20} color={p.fg} />
    </Pressable>
  )

  return (
    <View style={[styles.pad, { backgroundColor: p.panel, borderTopColor: p.border }]}>
      <View style={styles.head}>
        {choice ? (
          <ScrollView
            horizontal
            style={styles.fill}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.options}
          >
            {choice.options.map((label, i) => {
              const on = i === choice.selected
              return (
                <Pressable
                  key={`${i}:${label}`}
                  onPress={tap(() => onPick(i))}
                  style={[
                    styles.option,
                    { borderColor: on ? p.accent : p.border, backgroundColor: on ? p.raised : 'transparent' },
                  ]}
                >
                  <Text style={[styles.optionText, { color: on ? p.fg : p.muted }]} numberOfLines={1}>
                    {i + 1}. {label}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        ) : (
          <Text style={[styles.hint, { color: p.muted }]}>Arrow keys</Text>
        )}
        <Pressable style={styles.close} onPress={tap(onClose)} hitSlop={6} accessibilityLabel="Hide arrow keys">
          <Ionicons name="close" size={18} color={p.muted} />
        </Pressable>
      </View>
      <View style={styles.keys}>
        <Pressable
          onPress={tap(() => onKey('\x1b'))}
          accessibilityLabel="Escape"
          style={({ pressed }) => [
            styles.key,
            { borderColor: p.border, backgroundColor: pressed ? p.raised : p.bg },
          ]}
        >
          <Text style={[styles.esc, { color: p.fg }]}>esc</Text>
        </Pressable>
        {key(ARROW.left, 'chevron-back', 'Left')}
        {key(ARROW.up, 'chevron-up', 'Up')}
        {key(ARROW.down, 'chevron-down', 'Down')}
        {key(ARROW.right, 'chevron-forward', 'Right')}
        <Pressable
          onPress={tap(() => onKey('\r'))}
          accessibilityLabel="Enter"
          style={({ pressed }) => [styles.key, styles.enter, { backgroundColor: p.accent, opacity: pressed ? 0.8 : 1 }]}
        >
          <Ionicons name="return-down-back" size={18} color={p.accentFg} />
          <Text style={[styles.enterText, { color: p.accentFg }]}>{choice ? 'Choose' : 'Enter'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pad: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, paddingBottom: 4, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 30 },
  options: { gap: 6, paddingHorizontal: 8, alignItems: 'center' },
  option: {
    height: 30,
    maxWidth: 240,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
  },
  optionText: { fontSize: 13 },
  hint: { flex: 1, fontSize: 13, paddingHorizontal: 12 },
  close: { width: 36, height: 30, alignItems: 'center', justifyContent: 'center' },
  keys: { flexDirection: 'row', gap: 6, paddingHorizontal: 8 },
  key: {
    flex: 1,
    height: 44,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  esc: { fontSize: 14, fontFamily: 'Menlo' },
  enter: { flex: 2, flexDirection: 'row', gap: 6, borderWidth: 0 },
  enterText: { fontSize: 15, fontWeight: '600' },
})
