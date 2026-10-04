import { useState } from 'react'
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { usePalette } from '../lib/theme'

interface Props {
  visible: boolean
  title: string
  onClose: () => void
  /** `submit`: followed by Enter, as a prompt is sent. */
  onSend: (text: string, submit: boolean) => void
}

/**
 * Writing a longer prompt with the phone's own editing, autocorrect and
 * dictation, then sending it in one go — what typing into a terminal
 * character by character on a phone is not good at.
 */
export function ComposeSheet({ visible, title, onClose, onSend }: Props) {
  const p = usePalette()
  const [text, setText] = useState('')
  const send = (submit: boolean) => {
    if (!text) return
    onSend(text, submit)
    setText('')
    onClose()
  }
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.fill, { backgroundColor: p.bg }]} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.head, { borderBottomColor: p.border }]}>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ color: p.muted, fontSize: 16 }}>Cancel</Text>
            </Pressable>
            <Text style={[styles.title, { color: p.fg }]} numberOfLines={1}>{title}</Text>
            <Pressable onPress={() => send(true)} hitSlop={10} disabled={!text}>
              <Text style={{ color: text ? p.accent : p.subtle, fontSize: 16, fontWeight: '600' }}>Send</Text>
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, { color: p.fg }]}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            placeholder="Write to the terminal…"
            placeholderTextColor={p.subtle}
            textAlignVertical="top"
          />
          <View style={[styles.foot, { borderTopColor: p.border }]}>
            <Pressable onPress={() => send(false)} disabled={!text}>
              <Text style={{ color: text ? p.muted : p.subtle }}>Insert without Enter</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  input: { flex: 1, padding: 16, fontSize: 16, lineHeight: 22 },
  foot: { padding: 14, borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'flex-end' },
})
