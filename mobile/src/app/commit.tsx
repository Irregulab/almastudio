import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'

import { baseName, timeAgo, useProject, useRequest } from '../lib/useRequest'
import { usePalette } from '../lib/theme'
import { Message, Row, SectionTitle } from '../components/ui'

/** A commit: its message and the files it changed. */
export default function Commit() {
  const p = usePalette()
  const project = useProject()
  const { root, id } = useLocalSearchParams<{ root: string; id: string }>()
  const { data, error } = useRequest(
    (c) => c.request('git.commit', { projectId: project!.id, root, id }),
    [project?.id, root, id],
  )
  if (!project) return <Message>No project.</Message>
  if (error) return <Message tone="error">{error}</Message>
  if (!data) return <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />

  return (
    <ScrollView style={{ backgroundColor: p.bg }}>
      <View style={styles.head}>
        <Text style={[styles.message, { color: p.fg }]}>{data.message.trim()}</Text>
        <Text style={{ color: p.muted, marginTop: 8 }}>
          {data.author} · {timeAgo(data.authorTime)} · {data.shortId}
        </Text>
      </View>
      <SectionTitle>{data.files.length} files changed</SectionTitle>
      {data.files.map((f) => (
        <Row
          key={f.path}
          title={baseName(f.path)}
          subtitle={f.path}
          right={
            <Text style={{ fontSize: 12 }}>
              <Text style={{ color: p.green }}>+{f.additions}</Text>{' '}
              <Text style={{ color: p.red }}>−{f.deletions}</Text>
            </Text>
          }
          chevron
          onPress={() =>
            router.push({
              pathname: '/diff',
              params: { root, path: f.path, side: 'worktree', target: data.id, oldPath: f.oldPath ?? '' },
            })
          }
        />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  head: { padding: 16 },
  message: { fontSize: 15, lineHeight: 21 },
})
