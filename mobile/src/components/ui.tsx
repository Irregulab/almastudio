import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { usePalette } from '../lib/theme'

/** A tappable list row, as the pages use for projects, files and changes. */
export function Row({
  title, subtitle, left, right, onPress, onLongPress, chevron, style,
}: {
  title: ReactNode
  subtitle?: ReactNode
  left?: ReactNode
  right?: ReactNode
  onPress?: () => void
  onLongPress?: () => void
  chevron?: boolean
  style?: ViewStyle
}) {
  const p = usePalette()
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: p.border, backgroundColor: pressed ? p.raised : 'transparent' },
        style,
      ]}
    >
      {left}
      <View style={styles.text}>
        {typeof title === 'string' ? (
          <Text style={[styles.title, { color: p.fg }]} numberOfLines={1}>{title}</Text>
        ) : title}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <Text style={[styles.subtitle, { color: p.muted }]} numberOfLines={1}>{subtitle}</Text>
          ) : subtitle
        ) : null}
      </View>
      {right}
      {chevron && <Ionicons name="chevron-forward" size={16} color={p.subtle} />}
    </Pressable>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const p = usePalette()
  return <Text style={[styles.section, { color: p.subtle }]}>{children}</Text>
}

export function Message({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  const p = usePalette()
  return (
    <View style={styles.message}>
      <Text style={{ color: tone === 'error' ? p.red : p.muted, textAlign: 'center', lineHeight: 20 }}>
        {children}
      </Text>
    </View>
  )
}

export function Button({
  title, onPress, kind = 'primary', disabled,
}: { title: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean }) {
  const p = usePalette()
  const bg = kind === 'primary' ? p.accent : 'transparent'
  const fg = kind === 'primary' ? p.accentFg : kind === 'danger' ? p.red : p.fg
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'primary' ? bg : p.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15.5 },
  subtitle: { fontSize: 12.5 },
  section: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
  },
  message: { padding: 32, alignItems: 'center' },
  button: {
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
})
