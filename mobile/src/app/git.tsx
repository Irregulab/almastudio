import { useEffect, useState } from 'react'
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native'
import { router } from 'expo-router'

import type { ChangedFile } from '@almastudio/protocol'
import { baseName, timeAgo, useProject, useRequest } from '../lib/useRequest'
import { usePalette, type Palette } from '../lib/theme'
import { Message, Row } from '../components/ui'

type View_ = 'changes' | 'history'

/** The project's repositories: what changed, and the history. Read-only. */
export default function Git() {
  const p = usePalette()
  const project = useProject()
  const [repo, setRepo] = useState<string | null>(null)
  const [view, setView] = useState<View_>('changes')

  const repos = useRequest((c) => c.request('git.repos', { projectId: project!.id }), [project?.id])
  useEffect(() => {
    if (repo || !repos.data || !project) return
    const own = repos.data.find((r) => r.path.replace(/\/+$/, '') === project.root.replace(/\/+$/, ''))
    setRepo(own?.path ?? repos.data[0]?.path ?? project.root)
  }, [project, repo, repos.data])

  if (!project) return <Message>No project.</Message>
  if (repos.error) return <Message tone="error">{repos.error}</Message>
  if (!repo) return <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      {(repos.data?.length ?? 0) > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.repos} contentContainerStyle={styles.reposContent}>
          {repos.data!.map((r) => (
            <Pressable
              key={r.path}
              onPress={() => setRepo(r.path)}
              style={[styles.chip, { borderColor: r.path === repo ? p.accent : p.border }]}
            >
              <Text style={{ color: r.path === repo ? p.fg : p.muted }}>{r.name}</Text>
              {r.dirty > 0 && <Text style={{ color: p.yellow, fontSize: 12 }}>{r.dirty}</Text>}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={[styles.segments, { backgroundColor: p.panel, borderColor: p.border }]}>
        {(['changes', 'history'] as const).map((v) => (
          <Pressable key={v} onPress={() => setView(v)} style={[styles.segment, view === v && { backgroundColor: p.raised }]}>
            <Text style={{ color: view === v ? p.fg : p.muted, fontWeight: '600' }}>
              {v === 'changes' ? 'Changes' : 'History'}
            </Text>
          </Pressable>
        ))}
      </View>
      {view === 'changes' ? <Changes root={repo} projectId={project.id} p={p} /> : <History root={repo} projectId={project.id} p={p} />}
    </View>
  )
}

const STATUS_COLOR = (code: string, p: Palette) =>
  code.includes('D') ? p.red : code.includes('A') || code === '??' ? p.green : p.yellow

function Changes({ root, projectId, p }: { root: string; projectId: string; p: Palette }) {
  const { data, error, loading, reload } = useRequest(
    (c) => c.request('git.status', { projectId, root }),
    [root, projectId],
  )
  if (error) return <Message tone="error">{error}</Message>
  if (!data) return <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />
  if (!data.isRepo) return <Message>Not a git repository.</Message>

  const staged = data.files.filter((f) => f.staged)
  const unstaged = data.files.filter((f) => f.unstaged || f.untracked || f.conflicted)
  const sections: Array<{ title: string; files: ChangedFile[]; side: 'index' | 'worktree' }> = [
    { title: 'Staged', files: staged, side: 'index' },
    { title: 'Changes', files: unstaged, side: 'worktree' },
  ]
  const rows = sections.flatMap((s) =>
    s.files.length ? [{ header: `${s.title} · ${s.files.length}` }, ...s.files.map((f) => ({ file: f, side: s.side }))] : [],
  )

  return (
    <FlatList
      data={rows}
      keyExtractor={(r, i) => ('header' in r ? r.header : `${r.side}:${r.file.path}`) + i}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
      ListHeaderComponent={
        <Text style={[styles.branch, { color: p.muted }]}>
          {data.detached ? 'Detached HEAD' : `On ${data.branch ?? '—'}`}
          {data.ahead ? `  ↑${data.ahead}` : ''}
          {data.behind ? `  ↓${data.behind}` : ''}
          {data.operation ? `  · ${data.operation} in progress` : ''}
        </Text>
      }
      ListEmptyComponent={<Message>Nothing changed.</Message>}
      renderItem={({ item }) =>
        'header' in item ? (
          <Text style={[styles.header, { color: p.subtle }]}>{item.header}</Text>
        ) : (
          <Row
            title={baseName(item.file.path)}
            subtitle={item.file.path}
            left={
              <Text style={[styles.code, { color: STATUS_COLOR(item.file.code, p) }]}>
                {item.file.untracked ? 'U' : item.file.code.trim().slice(0, 1) || 'M'}
              </Text>
            }
            chevron
            onPress={() =>
              router.push({
                pathname: '/diff',
                params: { root, path: item.file.path, side: item.side, oldPath: item.file.oldPath ?? '' },
              })
            }
          />
        )
      }
    />
  )
}

function History({ root, projectId, p }: { root: string; projectId: string; p: Palette }) {
  const { data, error, loading, reload } = useRequest(
    (c) => c.request('git.graph', { projectId, root, limit: 150 }),
    [root, projectId],
  )
  if (error) return <Message tone="error">{error}</Message>
  if (!data) return <ActivityIndicator style={{ marginTop: 40 }} color={p.muted} />
  return (
    <FlatList
      data={data}
      keyExtractor={(c) => c.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
      ListEmptyComponent={<Message>No commits yet.</Message>}
      renderItem={({ item }) => (
        <Row
          title={item.summary}
          subtitle={`${item.shortId} · ${item.author} · ${timeAgo(item.time)}`}
          right={
            item.refs.length ? (
              <View style={styles.refs}>
                {item.refs.slice(0, 2).map((r) => (
                  <Text key={r.name} numberOfLines={1} style={[styles.ref, { color: p.accent, borderColor: p.accent }]}>
                    {r.name}
                  </Text>
                ))}
              </View>
            ) : undefined
          }
          onPress={() => router.push({ pathname: '/commit', params: { root, id: item.id } })}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  repos: { flexGrow: 0 },
  reposContent: { gap: 6, padding: 10 },
  chip: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  segments: { flexDirection: 'row', margin: 10, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 7 },
  branch: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  code: { fontFamily: 'Menlo', fontWeight: '700', width: 16, textAlign: 'center' },
  refs: { gap: 3, maxWidth: 110, alignItems: 'flex-end' },
  ref: { fontSize: 11, borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, overflow: 'hidden' },
})
