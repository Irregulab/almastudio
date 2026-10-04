import { useMemo } from 'react'
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'

import { baseName, useProject, useRequest } from '../lib/useRequest'
import { usePalette } from '../lib/theme'
import { Message } from '../components/ui'

const LINE_HEIGHT = 18

/** A file, read-only, with line numbers; opened at a line from search. */
export default function FileView() {
  const p = usePalette()
  const project = useProject()
  const { path, line, root } = useLocalSearchParams<{ path: string; line?: string; root?: string }>()
  const { data, error, loading } = useRequest(
    (c) => c.request('fs.read', { projectId: project!.id, root, path }),
    [project?.id, path, root],
  )
  const lines = useMemo(() => (data?.content ?? '').split('\n'), [data])
  const target = line ? Math.max(0, Number(line) - 1) : undefined
  const gutter = String(lines.length).length

  if (!project) return <Message>No project.</Message>
  return (
    <>
      <Stack.Screen options={{ title: baseName(path) }} />
      {error ? (
        <Message tone="error">{error}</Message>
      ) : loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />
      ) : data?.binary ? (
        <Message>A binary file; there is nothing to show as text.</Message>
      ) : data?.truncated ? (
        <Message>Too large to show here.</Message>
      ) : (
        <FlatList
          style={{ backgroundColor: p.termBg }}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          initialScrollIndex={target && target < lines.length ? Math.max(0, target - 5) : undefined}
          getItemLayout={(_, i) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * i, index: i })}
          initialNumToRender={80}
          renderItem={({ item, index }) => (
            <View
              style={[
                styles.line,
                index === target && { backgroundColor: p.yellow + '33' },
              ]}
            >
              <Text style={[styles.no, { color: p.subtle, width: gutter * 8 + 10 }]}>{index + 1}</Text>
              <Text style={[styles.code, { color: p.termFg }]} numberOfLines={1}>{item || ' '}</Text>
            </View>
          )}
        />
      )}
    </>
  )
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', height: LINE_HEIGHT, alignItems: 'center' },
  no: { fontFamily: 'Menlo', fontSize: 11, textAlign: 'right', paddingRight: 8 },
  code: { fontFamily: 'Menlo', fontSize: 12, flex: 1 },
})
