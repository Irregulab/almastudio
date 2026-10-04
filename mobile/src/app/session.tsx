import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

import type { HarnessKind, RemoteTab } from '@almastudio/protocol'
import { ComposeSheet } from '../components/ComposeSheet'
import { KeyBar } from '../components/KeyBar'
import { TerminalPane, type TerminalHandle } from '../components/TerminalPane'
import { useConnection } from '../lib/connection'
import { HARNESS_ICON, HARNESS_LABEL } from '../lib/harness'
import { usePalette, type Palette } from '../lib/theme'

/**
 * The main screen: the terminal of one tab, full screen, and the strip of the
 * project's tabs above it. Projects, files, git and search open as pages of
 * their own on top, so nothing ever shares this screen with the terminal.
 */
export default function Session() {
  const p = usePalette()
  const conn = useConnection((s) => s.conn)
  const status = useConnection((s) => s.status)
  const error = useConnection((s) => s.error)
  const route = useConnection((s) => s.route)
  const workspace = useConnection((s) => s.workspace)
  const projectId = useConnection((s) => s.projectId)
  const tabId = useConnection((s) => s.tabId)
  const busy = useConnection((s) => s.busy)
  const attention = useConnection((s) => s.attention)
  const prefs = useConnection((s) => s.prefs)
  const selectTab = useConnection((s) => s.selectTab)
  const desktopName = useConnection(
    (s) => s.desktops.find((d) => d.id === s.activeId)?.name ?? 'Computer',
  )

  const term = useRef<TerminalHandle>(null)
  const [ctrl, setCtrl] = useState(false)
  const [compose, setCompose] = useState(false)
  const [state, setState] = useState<{ alive: boolean; exitCode: number } | null>(null)

  const project = workspace?.projects.find((x) => x.id === projectId) ?? null
  const tab = project?.tabs.find((t) => t.id === tabId) ?? null

  // The tab's own status is the source of truth once the workspace says so.
  useEffect(() => setState(null), [tabId])
  const running = tab?.status === 'running' || (state?.alive ?? false)

  const startTab = useCallback(
    (t: RemoteTab, restart: boolean) => {
      if (!conn) return
      void conn
        .request(restart ? 'tab.restart' : 'tab.start', { tabId: t.id, cols: 80, rows: 30 })
        .catch((e) => Alert.alert('Could not start', String(e.message ?? e)))
    },
    [conn],
  )

  const openTab = useCallback(
    (kind: HarnessKind) => {
      if (!conn || !project) return
      void conn
        .request('tab.open', { projectId: project.id, kind, cols: 80, rows: 30 })
        .then(({ tabId: id }) => selectTab(id))
        .catch((e) => Alert.alert('Could not open a tab', String(e.message ?? e)))
    },
    [conn, project, selectTab],
  )

  const tabActions = useCallback(
    (t: RemoteTab) => {
      if (!conn) return
      const actions: Array<{ label: string; run: () => void; destructive?: boolean }> = [
        { label: t.status === 'running' ? 'Restart' : 'Start', run: () => startTab(t, t.status === 'running') },
        ...(t.status === 'running'
          ? [{ label: 'Stop', run: () => void conn.request('tab.kill', { tabId: t.id }).catch(() => {}) }]
          : []),
        { label: 'Close tab', destructive: true, run: () => void conn.request('tab.close', { tabId: t.id }).catch(() => {}) },
      ]
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: t.title,
            options: [...actions.map((a) => a.label), 'Cancel'],
            destructiveButtonIndex: actions.findIndex((a) => a.destructive),
            cancelButtonIndex: actions.length,
          },
          (i) => actions[i]?.run(),
        )
      } else {
        Alert.alert(t.title, undefined, [
          ...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? 'destructive' as const : 'default' as const })),
          { text: 'Cancel', style: 'cancel' },
        ])
      }
    },
    [conn, startTab],
  )

  const banner = useMemo(() => {
    if (status === 'online') return null
    if (status === 'connecting') return { text: `Connecting to ${desktopName}…`, tone: p.muted }
    if (error) return { text: error, tone: p.red }
    return { text: `Offline — reconnecting to ${desktopName}`, tone: p.yellow }
  }, [desktopName, error, p, status])

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: p.bg }]} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header: the project (opens the picker) and the pages. */}
      <View style={[styles.header, { borderBottomColor: p.border }]}>
        <Pressable style={styles.project} onPress={() => router.push('/projects')} hitSlop={6}>
          <View style={[styles.dot, { backgroundColor: project?.color ?? p.subtle }]} />
          <Text style={[styles.projectName, { color: p.fg }]} numberOfLines={1}>
            {project ? project.name : workspace ? 'No projects' : desktopName}
          </Text>
          <Ionicons name="chevron-down" size={14} color={p.muted} />
          {route === 'relay' && <Ionicons name="cloud-outline" size={13} color={p.subtle} />}
        </Pressable>
        <HeaderButton icon="add" label="New tab" p={p} disabled={!project} onPress={() => router.push('/new-tab')} />
        <HeaderButton icon="folder-outline" label="Files" p={p} disabled={!project} onPress={() => router.push('/files')} />
        <HeaderButton icon="git-branch-outline" label="Git" p={p} disabled={!project} onPress={() => router.push('/git')} />
        <HeaderButton icon="search" label="Search" p={p} disabled={!project} onPress={() => router.push('/search')} />
        <HeaderButton icon="ellipsis-horizontal" label="More" p={p} onPress={() => router.push('/settings')} />
      </View>

      {banner && (
        <View style={[styles.banner, { backgroundColor: p.panel }]}>
          {status === 'connecting' && <ActivityIndicator size="small" color={p.muted} />}
          <Text style={{ color: banner.tone, fontSize: 12.5, flex: 1 }}>{banner.text}</Text>
        </View>
      )}

      {/* Tab strip. */}
      {project && project.tabs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.strip, { borderBottomColor: p.border }]}
          contentContainerStyle={styles.stripContent}
        >
          {project.tabs.map((t) => {
            const on = t.id === tabId
            const mark = attention[t.id]
            return (
              <Pressable
                key={t.id}
                onPress={() => selectTab(t.id)}
                onLongPress={() => tabActions(t)}
                style={[
                  styles.chip,
                  { borderColor: on ? project.color : p.border, backgroundColor: on ? p.raised : 'transparent' },
                ]}
              >
                <Ionicons name={HARNESS_ICON[t.kind]} size={13} color={on ? p.fg : p.muted} />
                <Text style={[styles.chipText, { color: on ? p.fg : p.muted }]} numberOfLines={1}>
                  {t.title}
                </Text>
                {mark ? (
                  <View style={[styles.badge, { backgroundColor: mark.kind === 'finished' ? p.green : p.yellow }]} />
                ) : busy[t.id] ? (
                  <ActivityIndicator size="small" color={p.accent} style={styles.spinner} />
                ) : t.status !== 'running' ? (
                  <View style={[styles.badge, { backgroundColor: p.subtle }]} />
                ) : null}
              </Pressable>
            )
          })}
        </ScrollView>
      )}

      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.fill}>
          {conn && tab ? (
            <TerminalPane
              key={`${tab.id}`}
              ref={term}
              conn={conn}
              tabId={tab.id}
              prefs={prefs}
              ctrl={ctrl}
              onCtrlUsed={() => setCtrl(false)}
              onState={setState}
            />
          ) : (
            <Empty p={p} workspace={!!workspace} project={project?.name} harnesses={workspace?.harnesses ?? []} onOpen={openTab} />
          )}
          {tab && !running && (
            <View style={[styles.stopped, { backgroundColor: p.panel, borderColor: p.border }]}>
              <Text style={{ color: p.muted, flex: 1 }}>
                {tab.status === 'exited' || state ? `Not running${state && !state.alive && state.exitCode ? ` (exit ${state.exitCode})` : ''}` : 'Not started'}
              </Text>
              <Pressable
                style={[styles.startBtn, { backgroundColor: p.accent }]}
                onPress={() => startTab(tab, false)}
              >
                <Text style={{ color: p.accentFg, fontWeight: '600' }}>Start</Text>
              </Pressable>
            </View>
          )}
        </View>
        {tab && (
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: p.panel }}>
            <KeyBar
              ctrl={ctrl}
              onCtrl={() => setCtrl((c) => !c)}
              onKey={(seq) => term.current?.send(seq)}
              onEnter={() => term.current?.send('\r')}
              onCompose={() => setCompose(true)}
              onKeyboard={() => term.current?.focus()}
            />
          </SafeAreaView>
        )}
      </KeyboardAvoidingView>

      <ComposeSheet
        visible={compose}
        title={tab?.title ?? ''}
        onClose={() => setCompose(false)}
        onSend={(text, submit) => {
          term.current?.paste(text)
          if (submit) setTimeout(() => term.current?.send('\r'), 150)
        }}
      />
    </SafeAreaView>
  )
}

function HeaderButton({
  icon, label, onPress, p, disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  p: Palette
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.headerBtn, pressed && { backgroundColor: p.raised }]}
    >
      <Ionicons name={icon} size={20} color={disabled ? p.subtle : p.fg} />
    </Pressable>
  )
}

function Empty({
  p, workspace, project, harnesses, onOpen,
}: {
  p: Palette
  workspace: boolean
  project?: string
  harnesses: HarnessKind[]
  onOpen: (k: HarnessKind) => void
}) {
  if (!workspace) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={p.muted} />
      </View>
    )
  }
  if (!project) {
    return (
      <View style={styles.empty}>
        <Text style={{ color: p.muted }}>This computer has no projects yet.</Text>
      </View>
    )
  }
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: p.fg }]}>No terminals in {project}</Text>
      <Text style={{ color: p.muted, marginBottom: 16 }}>Start one; it runs on the computer.</Text>
      {[...harnesses, 'shell' as const].map((k) => (
        <Pressable
          key={k}
          onPress={() => onOpen(k)}
          style={[styles.emptyBtn, { borderColor: p.border, backgroundColor: p.panel }]}
        >
          <Ionicons name={HARNESS_ICON[k]} size={16} color={p.accent} />
          <Text style={{ color: p.fg, fontSize: 15 }}>{HARNESS_LABEL[k]}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  project: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 6, minWidth: 0 },
  projectName: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 7 },
  strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  stripContent: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 200,
  },
  chipText: { fontSize: 13, flexShrink: 1 },
  badge: { width: 7, height: 7, borderRadius: 4 },
  spinner: { transform: [{ scale: 0.6 }], width: 10, height: 10 },
  stopped: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    paddingLeft: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  startBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: 240,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
