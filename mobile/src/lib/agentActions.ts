import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'

import { ConnectError, RemoteConnection } from '@almastudio/protocol/src/client'
import { fromBase64Url } from '@almastudio/protocol/src/noise'
import {
  AGENT_CATEGORY,
  type AgentAnswer, type AgentAnswers, type AnswerOutcome, type Events, type RemoteWorkspace,
} from '@almastudio/protocol/src/index'
import { finishBackgroundWork } from '../../modules/background-work'
import { candidateUrls, hello, useConnection } from './connection'
import { randomBytes } from './random'
import { deviceKeyPair, loadDesktops } from './storage'

/**
 * Buttons on an agent's notification: Allow and Deny on a permission prompt,
 * Reply on an agent waiting at its prompt — answered from the lock screen or
 * a watch without opening the app. The app wakes in the background, reaches
 * the computer and asks it to type the answer, which it does only if the tab
 * still waits on that very prompt.
 *
 * iOS only: there an action asks for the phone to be unlocked first (a watch
 * on the wrist counts), while Android would run it straight from the lock
 * screen. And iOS only runs the app's JS for an action while the app is
 * suspended, not after it was quit: then the answer goes out the next time
 * the app opens, and the computer refuses it if anything was typed since.
 */

export const answersAvailable = Platform.OS === 'ios'

const ANSWERS: readonly AgentAnswer[] = ['allow', 'deny', 'reply']

async function registerCategories() {
  const answer = { opensAppToForeground: false, isAuthenticationRequired: true }
  await Notifications.setNotificationCategoryAsync(AGENT_CATEGORY.decision, [
    { identifier: 'allow', buttonTitle: 'Allow', options: answer },
    { identifier: 'deny', buttonTitle: 'Deny', options: { ...answer, isDestructive: true } },
  ])
  await Notifications.setNotificationCategoryAsync(AGENT_CATEGORY.reply, [
    {
      identifier: 'reply',
      buttonTitle: 'Reply',
      textInput: { submitButtonTitle: 'Send', placeholder: 'Message for the agent' },
      options: answer,
    },
  ])
}

if (answersAvailable) void registerCategories().catch(() => {})

/** The buttons for an event, as the desktop says it can be answered. */
function categoryFor(answers: AgentAnswers | undefined): string | undefined {
  if (!answersAvailable) return undefined
  if (answers === 'decision') return AGENT_CATEGORY.decision
  if (answers === 'reply') return AGENT_CATEGORY.reply
  return undefined
}

async function notify(content: Notifications.NotificationContentInput) {
  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== 'granted') return
  await Notifications.scheduleNotificationAsync({ content, trigger: null })
}

/**
 * The notification for an agent event the desktop told this app about
 * directly — while connected it sends no push. Names come from the
 * workspace when there is one.
 */
export function showAgentNotice(
  desktopId: string,
  e: Events['agent'],
  workspace: RemoteWorkspace | null,
) {
  const project = workspace?.projects.find((p) => p.id === e.projectId)
  const tab = project?.tabs.find((t) => t.id === e.tabId)
  const who = tab?.title ?? 'An agent'
  const body =
    e.kind === 'permission' ? e.message ?? `${who} needs your permission`
      : e.kind === 'needs-input' ? `${who} is waiting for you`
        : `${who} finished`
  const category = e.id === undefined ? undefined : categoryFor(e.answers)
  void notify({
    title: project?.name ?? 'AlmaStudio',
    body,
    data: { desktopId, projectId: e.projectId, tabId: e.tabId, eventId: e.id },
    ...(category ? { categoryIdentifier: category } : {}),
  }).catch(() => {})
}

interface Target {
  desktopId: string
  projectId: string
  tabId: string
  eventId: number
}

function targetOf(response: Notifications.NotificationResponse): Target | null {
  const d = response.notification.request.content.data as Record<string, unknown> | undefined
  if (
    typeof d?.desktopId !== 'string' || typeof d.tabId !== 'string' ||
    typeof d.eventId !== 'number'
  ) return null
  return {
    desktopId: d.desktopId,
    projectId: typeof d.projectId === 'string' ? d.projectId : '',
    tabId: d.tabId,
    eventId: d.eventId,
  }
}

/** Why an answer did not get to the computer. */
type Failure = 'unreachable' | 'unpaired' | 'outdated'

/**
 * Sends the answer over the open connection to that desktop, or over one of
 * its own for just this — which is what happens in the background, since
 * the app closes its connection on leaving the screen.
 */
async function send(t: Target, answer: AgentAnswer, text?: string): Promise<AnswerOutcome> {
  const s = useConnection.getState()
  const open = s.activeId === t.desktopId && s.conn && !s.conn.isClosed ? s.conn : null
  let own: RemoteConnection | null = null
  if (!open) {
    const desktops = s.booted ? s.desktops : await loadDesktops()
    const desktop = desktops.find((d) => d.id === t.desktopId)
    if (!desktop) throw new ConnectError('not paired', 'not-paired')
    own = await RemoteConnection.connect({
      urls: candidateUrls(desktop),
      desktopKey: fromBase64Url(desktop.id),
      keyPair: await deviceKeyPair(),
      hello: hello(),
      random: randomBytes,
    })
    // While connected the desktop tells this device of new events instead of
    // pushing them — the next prompt can come that quickly after an Allow.
    own.on('agent', (e) => showAgentNotice(desktop.id, e, null))
  }
  const conn = open ?? own!
  try {
    const { outcome } = await conn.request('agent.answer', {
      tabId: t.tabId,
      eventId: t.eventId,
      answer,
      ...(text ? { text } : {}),
    })
    return outcome
  } finally {
    own?.close()
  }
}

function failureOf(err: unknown): Failure {
  if (err instanceof ConnectError && err.reason === 'not-paired') return 'unpaired'
  if (String((err as Error)?.message ?? err).startsWith('unknown method')) return 'outdated'
  return 'unreachable'
}

const DONE: Record<AgentAnswer, string> = { allow: 'Allowed', deny: 'Denied', reply: 'Sent' }

/** Says what became of an answer, when that is not what was expected. */
function report(
  outcome: AnswerOutcome | Failure,
  answer: AgentAnswer,
  t: Target,
  original: Notifications.NotificationContent,
) {
  let body: string | null = null
  switch (outcome) {
    // Sent from the background, as asked: nothing to add. In front, the app
    // was opened after being quit and sent it late — worth saying.
    case 'sent':
      if (AppState.currentState === 'active') {
        body = original.body ? `${DONE[answer]}: ${original.body}` : `${DONE[answer]}.`
      }
      break
    case 'already': break
    case 'stale': body = 'Not sent: it was answered, or typed into, since.'; break
    case 'gone': body = 'Not sent: that tab is no longer running.'; break
    case 'asking': body = 'Not sent: a prompt on the computer needs answering first.'; break
    case 'unreachable': body = 'Not sent: the computer could not be reached.'; break
    case 'unpaired': body = 'Not sent: this device is no longer paired with that computer.'; break
    case 'outdated': body = 'Not sent: update AlmaStudio on the computer to answer from notifications.'; break
  }
  if (!body) return
  void notify({
    title: original.title ?? 'AlmaStudio',
    body,
    // Tapped, it opens the tab.
    data: { desktopId: t.desktopId, projectId: t.projectId, tabId: t.tabId },
  }).catch(() => {})
}

/** Responses already taken care of: the listener and the launch both see one. */
const handled = new Set<string>()

/**
 * Answers a notification's button. False for a plain tap, which is for the
 * caller to handle by opening the tab.
 */
export function handleAction(response: Notifications.NotificationResponse): boolean {
  const answer = ANSWERS.find((a) => a === response.actionIdentifier)
  if (!answer) return false
  const key = `${response.notification.request.identifier}:${answer}`
  if (handled.has(key)) return true
  handled.add(key)
  const target = targetOf(response)
  const text = answer === 'reply' ? response.userText?.trim() : undefined
  if (!target || (answer === 'reply' && !text)) {
    finishBackgroundWork()
    return true
  }
  void send(target, answer, text)
    .then(
      (outcome) => report(outcome, answer, target, response.notification.request.content),
      (err) => report(failureOf(err), answer, target, response.notification.request.content),
    )
    .finally(finishBackgroundWork)
  return true
}
