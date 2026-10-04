import { useEffect } from 'react'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'

import { useConnection } from './connection'

/**
 * Push notifications: an agent finished, or waits for permission or input.
 * They come from the desktop through Expo's push service while the app is
 * not connected — while it is, the desktop tells it directly instead.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

/** The EAS project push tokens are issued for; unset until `eas init`. */
export function pushProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId
}

async function pushToken(): Promise<string | null> {
  const projectId = pushProjectId()
  if (!Device.isDevice || !projectId) return null
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('agents', {
      name: 'Agents',
      importance: Notifications.AndroidImportance.HIGH,
    })
  }
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return null
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data
}

function openFrom(response: Notifications.NotificationResponse | null) {
  const data = response?.notification.request.content.data as
    | { desktopId?: string; projectId?: string; tabId?: string }
    | undefined
  if (!data?.desktopId || !data.tabId) return
  const { desktops, openAt } = useConnection.getState()
  if (!desktops.some((d) => d.id === data.desktopId)) return
  openAt(data.desktopId, data.projectId ?? '', data.tabId)
  router.navigate('/session')
}

export function useNotifications() {
  const conn = useConnection((s) => s.conn)
  const enabled = useConnection((s) => s.prefs.notifications)
  const booted = useConnection((s) => s.booted)

  // Tell each desktop, once connected, where to push — or to stop.
  useEffect(() => {
    if (!conn) return
    if (!enabled) {
      void conn.request('push.unregister', {}).catch(() => {})
      return
    }
    void pushToken()
      .then((token) => token && conn.request('push.register', { token, platform: Platform.OS }))
      .catch(() => {})
  }, [conn, enabled])

  // While connected the desktop tells the app itself; an agent in a tab other
  // than the one on screen gets a banner, which opens it when tapped.
  useEffect(() => {
    if (!conn || !enabled) return
    return conn.on('agent', (e) => {
      const s = useConnection.getState()
      if (e.tabId === s.tabId) return
      const project = s.workspace?.projects.find((p) => p.id === e.projectId)
      const tab = project?.tabs.find((t) => t.id === e.tabId)
      const who = tab?.title ?? 'An agent'
      const body =
        e.kind === 'permission' ? e.message ?? `${who} needs your permission`
          : e.kind === 'needs-input' ? `${who} is waiting for you`
            : `${who} finished`
      void Notifications.requestPermissionsAsync()
        .then(async ({ status }) => {
          if (status !== 'granted') return
          await Notifications.scheduleNotificationAsync({
          content: {
            title: project?.name ?? 'AlmaStudio',
            body,
            data: { desktopId: s.activeId, projectId: e.projectId, tabId: e.tabId },
          },
            trigger: null,
          })
        })
        .catch(() => {})
    })
  }, [conn, enabled])

  // A notification tapped opens its tab, whether the app was running or not.
  useEffect(() => {
    if (!booted) return
    void Notifications.getLastNotificationResponseAsync().then(openFrom)
    const sub = Notifications.addNotificationResponseReceivedListener(openFrom)
    return () => sub.remove()
  }, [booted])
}
