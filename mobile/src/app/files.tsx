import { ActivityIndicator, FlatList, RefreshControl } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

import { baseName, useProject, useRequest } from '../lib/useRequest'
import { usePalette } from '../lib/theme'
import { Message, Row } from '../components/ui'

/** One folder of the project, as the desktop's Files panel shows it. */
export default function Files() {
  const p = usePalette()
  const project = useProject()
  const params = useLocalSearchParams<{ dir?: string }>()
  const dir = params.dir ?? project?.root ?? ''
  const { data, error, loading, reload } = useRequest(
    (c) => c.request('fs.list', { projectId: project!.id, dir }),
    [project?.id, dir],
  )
  if (!project) return <Message>No project.</Message>

  return (
    <>
      <Stack.Screen options={{ title: dir === project.root ? project.name : baseName(dir) }} />
      {error ? (
        <Message tone="error">{error}</Message>
      ) : loading && !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />
      ) : (
        <FlatList
          style={{ backgroundColor: p.bg }}
          data={data ?? []}
          keyExtractor={(e) => e.path}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={<Message>Empty folder.</Message>}
          renderItem={({ item }) => (
            <Row
              title={item.name}
              subtitle={item.isDir ? undefined : formatSize(item.size)}
              left={
                <Ionicons
                  name={item.isDir ? 'folder' : 'document-text-outline'}
                  size={20}
                  color={item.isDir ? p.accent : p.muted}
                />
              }
              chevron={item.isDir}
              onPress={() =>
                item.isDir
                  ? router.push({ pathname: '/files', params: { dir: item.path } })
                  : router.push({ pathname: '/file', params: { path: item.path } })
              }
            />
          )}
        />
      )}
    </>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
