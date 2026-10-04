import { useState } from 'react'
import { Alert, ScrollView } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

import type { HarnessKind } from '@almastudio/protocol'
import { useConnection } from '../lib/connection'
import { HARNESS_ICON, HARNESS_LABEL } from '../lib/harness'
import { usePalette } from '../lib/theme'
import { Message, Row, SectionTitle } from '../components/ui'

/** Opens a terminal in the current project, running on the computer. */
export default function NewTab() {
  const p = usePalette()
  const conn = useConnection((s) => s.conn)
  const workspace = useConnection((s) => s.workspace)
  const projectId = useConnection((s) => s.projectId)
  const selectTab = useConnection((s) => s.selectTab)
  const [busy, setBusy] = useState(false)
  const project = workspace?.projects.find((x) => x.id === projectId)
  if (!project || !conn) return <Message>Not connected.</Message>

  const kinds: HarnessKind[] = [...(workspace?.harnesses ?? []), 'shell']
  const open = (kind: HarnessKind) => {
    if (busy) return
    setBusy(true)
    conn
      .request('tab.open', { projectId: project.id, kind, cols: 80, rows: 30 })
      .then(({ tabId }) => {
        selectTab(tabId)
        router.back()
      })
      .catch((e) => Alert.alert('Could not open a tab', String(e.message ?? e)))
      .finally(() => setBusy(false))
  }

  return (
    <ScrollView style={{ backgroundColor: p.bg }}>
      <SectionTitle>In {project.name}</SectionTitle>
      {kinds.map((k) => (
        <Row
          key={k}
          title={HARNESS_LABEL[k]}
          subtitle={k === 'shell' ? 'A shell in the project folder' : 'An agent in the project folder'}
          left={<Ionicons name={HARNESS_ICON[k]} size={20} color={p.accent} />}
          onPress={() => open(k)}
          chevron
        />
      ))}
    </ScrollView>
  )
}
