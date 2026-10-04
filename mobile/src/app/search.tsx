import { useState } from 'react'
import {
  ActivityIndicator, Pressable, SectionList, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { router } from 'expo-router'

import type { SearchResults } from '@almastudio/protocol'
import { useConnection } from '../lib/connection'
import { useProject } from '../lib/useRequest'
import { usePalette } from '../lib/theme'
import { Message } from '../components/ui'

/** Text search across the project, as the desktop's Search panel does it. */
export default function Search() {
  const p = usePalette()
  const project = useProject()
  const conn = useConnection((s) => s.conn)
  const [pattern, setPattern] = useState('')
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [results, setResults] = useState<SearchResults | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!project) return <Message>No project.</Message>

  const run = () => {
    if (!conn || !pattern) return
    setBusy(true)
    setError(null)
    conn
      .request('search.text', { projectId: project.id, pattern, ...opts })
      .then(setResults, (e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false))
  }

  const toggle = (key: keyof typeof opts, label: string) => (
    <Pressable
      onPress={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
      style={[styles.toggle, { borderColor: opts[key] ? p.accent : p.border, backgroundColor: opts[key] ? p.accent + '22' : 'transparent' }]}
    >
      <Text style={{ color: opts[key] ? p.fg : p.muted, fontFamily: 'Menlo', fontSize: 13 }}>{label}</Text>
    </Pressable>
  )

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={[styles.bar, { borderBottomColor: p.border }]}>
        <TextInput
          value={pattern}
          onChangeText={setPattern}
          onSubmitEditing={run}
          placeholder={`Search in ${project.name}`}
          placeholderTextColor={p.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          autoFocus
          style={[styles.input, { color: p.fg, backgroundColor: p.panel, borderColor: p.border }]}
        />
        <View style={styles.toggles}>
          {toggle('caseSensitive', 'Aa')}
          {toggle('wholeWord', 'ab')}
          {toggle('regex', '.*')}
        </View>
      </View>
      {error ? (
        <Message tone="error">{error}</Message>
      ) : busy ? (
        <ActivityIndicator style={{ marginTop: 30 }} color={p.muted} />
      ) : results ? (
        <SectionList
          sections={results.files.map((f) => ({ title: f.rel, path: f.path, data: f.matches }))}
          keyExtractor={(m, i) => `${m.line}:${m.column}:${i}`}
          stickySectionHeadersEnabled
          ListHeaderComponent={
            <Text style={[styles.count, { color: p.muted }]}>
              {results.matchCount} results in {results.files.length} files{results.truncated ? ' (stopped early)' : ''}
            </Text>
          }
          ListEmptyComponent={<Message>No results.</Message>}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.file, { color: p.fg, backgroundColor: p.panel }]} numberOfLines={1}>
              {section.title}
            </Text>
          )}
          renderItem={({ item, section }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/file', params: { path: section.path, line: String(item.line) } })}
              style={({ pressed }) => [styles.match, { borderBottomColor: p.border, backgroundColor: pressed ? p.raised : 'transparent' }]}
            >
              <Text style={[styles.lineNo, { color: p.subtle }]}>{item.line}</Text>
              <Text style={[styles.preview, { color: p.fg }]} numberOfLines={2}>{item.preview.trim()}</Text>
            </Pressable>
          )}
        />
      ) : (
        <Message>Search the project's files on the computer.</Message>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { padding: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { height: 42, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  toggles: { flexDirection: 'row', gap: 6 },
  toggle: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 7, borderWidth: 1 },
  count: { padding: 12, fontSize: 12.5 },
  file: { fontSize: 13, fontWeight: '600', paddingHorizontal: 12, paddingVertical: 6 },
  match: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  lineNo: { fontFamily: 'Menlo', fontSize: 11, width: 34, textAlign: 'right', paddingTop: 1 },
  preview: { fontFamily: 'Menlo', fontSize: 12, flex: 1 },
})
