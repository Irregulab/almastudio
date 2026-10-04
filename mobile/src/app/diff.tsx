import { ActivityIndicator, ScrollView, Text } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'

import { DiffHunks } from '../components/DiffHunks'
import { baseName, useProject, useRequest } from '../lib/useRequest'
import { usePalette } from '../lib/theme'
import { Message } from '../components/ui'

/** One file's change: in the working tree, the index, or a commit. */
export default function Diff() {
  const p = usePalette()
  const project = useProject()
  const q = useLocalSearchParams<{
    root: string; path: string; side?: 'worktree' | 'index'; target?: string; base?: string; oldPath?: string
  }>()
  const { data, error } = useRequest(
    (c) =>
      c.request('git.diff', {
        projectId: project!.id,
        root: q.root,
        path: q.path,
        side: q.side ?? 'worktree',
        target: q.target || undefined,
        base: q.base || undefined,
        oldPath: q.oldPath || undefined,
      }),
    [project?.id, q.root, q.path, q.side, q.target, q.base],
  )
  if (!project) return <Message>No project.</Message>
  return (
    <>
      <Stack.Screen options={{ title: baseName(q.path) }} />
      {error ? (
        <Message tone="error">{error}</Message>
      ) : !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />
      ) : data.binary ? (
        <Message>A binary file changed.</Message>
      ) : (
        <ScrollView style={{ backgroundColor: p.bg }}>
          <Text style={{ color: p.muted, padding: 12, fontSize: 12.5 }}>
            {q.path}  <Text style={{ color: p.green }}>+{data.additions}</Text>{' '}
            <Text style={{ color: p.red }}>−{data.deletions}</Text>
          </Text>
          {data.hunks.length === 0 ? <Message>No changes to show.</Message> : <DiffHunks diff={data} />}
          {data.truncated && <Message>The rest is too large to show here.</Message>}
        </ScrollView>
      )}
    </>
  )
}
