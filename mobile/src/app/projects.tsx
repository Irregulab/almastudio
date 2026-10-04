import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'

import { useConnection } from '../lib/connection'
import { usePalette } from '../lib/theme'
import { Message, Row, SectionTitle } from '../components/ui'

/** Picks the project whose terminals the main screen shows. */
export default function Projects() {
  const p = usePalette()
  const workspace = useConnection((s) => s.workspace)
  const current = useConnection((s) => s.projectId)
  const busy = useConnection((s) => s.busy)
  const attention = useConnection((s) => s.attention)
  const select = useConnection((s) => s.selectProject)

  if (!workspace) return <Message>Waiting for the computer…</Message>
  if (workspace.projects.length === 0) return <Message>This computer has no projects yet.</Message>

  // Grouped by the sidebar's categories, as on the desktop.
  const groups = new Map<string, typeof workspace.projects>()
  for (const project of workspace.projects) {
    const key = project.category ?? ''
    groups.set(key, [...(groups.get(key) ?? []), project])
  }

  return (
    <ScrollView style={{ backgroundColor: p.bg }}>
      {[...groups.entries()].map(([category, projects]) => (
        <View key={category}>
          {category ? <SectionTitle>{category}</SectionTitle> : <View style={{ height: 8 }} />}
          {projects.map((project) => {
            const running = project.tabs.filter((t) => t.status === 'running').length
            const working = project.tabs.some((t) => busy[t.id])
            const waiting = project.tabs.some((t) => attention[t.id])
            return (
              <Row
                key={project.id}
                title={project.name}
                subtitle={
                  project.tabs.length === 0
                    ? project.root
                    : `${project.tabs.length} terminal${project.tabs.length === 1 ? '' : 's'}, ${running} running`
                }
                left={
                  <View style={[styles.icon, { backgroundColor: project.color + '33' }]}>
                    <Text style={{ fontSize: 17 }}>{project.icon || '•'}</Text>
                  </View>
                }
                right={
                  waiting ? (
                    <View style={[styles.dot, { backgroundColor: p.yellow }]} />
                  ) : working ? (
                    <ActivityIndicator size="small" color={p.accent} />
                  ) : project.id === current ? (
                    <View style={[styles.dot, { backgroundColor: project.color }]} />
                  ) : null
                }
                onPress={() => {
                  select(project.id)
                  router.back()
                }}
              />
            )
          })}
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  icon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5 },
})
