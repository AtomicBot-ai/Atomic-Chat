import { create } from 'zustand'

import { localStorageKey } from '@/constants/localStorage'
import { findChatModel, type ChatModelRef } from '@/lib/onboarding/jobs'
import {
  EmailReminderError,
  notifyEmailReminder,
  registerEmailReminder,
} from '@/services/email-reminders'

type Reminder = ChatModelRef & {
  modelName: string
  registeredAt: number
  ready: boolean
  attempts: number
  nextAttemptAt: number
  status: 'waiting' | 'queued' | 'expired' | 'failed'
}

type ReminderData = { token: string | null; reminder: Reminder | null }
const empty: ReminderData = { token: null, reminder: null }
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RETRY_MS = 2 * 60 * 1000
const MAX_RETRY_MS = 30 * 60 * 1000

/** Only the random token and model metadata survive a relaunch, never the email. */
export function readEmailReminder(): ReminderData {
  try {
    const data = JSON.parse(
      localStorage.getItem(localStorageKey.emailReminder) ?? 'null'
    ) as ReminderData | null
    if (
      !data ||
      typeof data.token !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(data.token)
    )
      return empty
    const r = data.reminder
    if (
      !r ||
      typeof r.provider !== 'string' ||
      !Array.isArray(r.matchIds) ||
      !r.matchIds.every((id) => typeof id === 'string') ||
      typeof r.modelName !== 'string' ||
      !Number.isFinite(r.registeredAt) ||
      !Number.isFinite(r.attempts) ||
      r.attempts < 0 ||
      !Number.isFinite(r.nextAttemptAt) ||
      typeof r.ready !== 'boolean' ||
      !['waiting', 'queued', 'expired', 'failed'].includes(r.status)
    )
      return { token: data.token, reminder: null }
    return { token: data.token, reminder: r }
  } catch {
    return empty
  }
}

export const useEmailReminderStore = create<ReminderData>()(() =>
  readEmailReminder()
)

function save(data: ReminderData): void {
  // Write first: a disabled/full store must not produce a false success in UI.
  localStorage.setItem(localStorageKey.emailReminder, JSON.stringify(data))
  useEmailReminderStore.setState(data)
}

function newToken(): string {
  // A bearer credential requires secure randomness, including without randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

// Registration and notification share one queue: a new address cannot race a
// notify for the previous address. Only an explicit submission performs PUT.
let queue: Promise<void> = Promise.resolve()
function serialize(work: () => Promise<void>): Promise<void> {
  const next = queue.then(work)
  queue = next.catch(() => undefined)
  return next
}

export function requestEmailReminder(
  email: string,
  locale: string,
  model: ChatModelRef & { title: string }
): Promise<void> {
  return serialize(async () => {
    const token = useEmailReminderStore.getState().token ?? newToken()
    // Stop the earlier reminder before changing its address. After an uncertain
    // PUT result, the form offers Retry instead of notifying the wrong address.
    save({ token, reminder: null })
    await registerEmailReminder(token, {
      email: email.trim(),
      locale: locale.toLowerCase().startsWith('ru') ? 'ru' : 'en',
      model_name: model.title.slice(0, 200),
      ...(typeof VERSION === 'string' ? { app_version: VERSION } : {}),
    })
    save({
      token,
      reminder: {
        provider: model.provider,
        matchIds: [...model.matchIds],
        modelName: model.title.slice(0, 200),
        registeredAt: Date.now(),
        ready: false,
        attempts: 0,
        nextAttemptAt: 0,
        status: 'waiting',
      },
    })
  })
}

let notification: Promise<void> | null = null

/** Called on every route and after relaunch; terminal responses never re-register. */
export function syncEmailReminder(
  providers: Parameters<typeof findChatModel>[1]
): Promise<void> {
  if (notification) return notification
  notification = serialize(async () => {
    const { token, reminder } = useEmailReminderStore.getState()
    if (!token || reminder?.status !== 'waiting') return
    if (Date.now() - reminder.registeredAt >= RETENTION_MS) {
      save({ token, reminder: { ...reminder, status: 'expired' } })
      return
    }
    if (!reminder.ready && !findChatModel(reminder, providers)) return
    if (Date.now() < reminder.nextAttemptAt) return
    const attempt: Reminder = {
      ...reminder,
      ready: true,
      attempts: reminder.attempts + 1,
      nextAttemptAt:
        Date.now() +
        Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(reminder.attempts, 4)),
    }
    // Persist readiness and backoff before sending; a quit or lost 202 retries
    // only the idempotent notify, even if the model is no longer selected.
    save({ token, reminder: attempt })
    try {
      await notifyEmailReminder(token, attempt.modelName)
      save({ token, reminder: { ...attempt, status: 'queued' } })
    } catch (error) {
      if (!(error instanceof EmailReminderError)) return
      if (error.status === 429) {
        save({
          token,
          reminder: {
            ...attempt,
            nextAttemptAt: Math.max(
              attempt.nextAttemptAt,
              Date.now() + error.retryAfterMs
            ),
          },
        })
      } else if (
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        save({
          token,
          reminder: {
            ...attempt,
            status: error.status === 404 ? 'expired' : 'failed',
          },
        })
      }
    }
  }).finally(() => {
    notification = null
  })
  return notification
}
