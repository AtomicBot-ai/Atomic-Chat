import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import { isPlatformTauri } from '@/lib/platform/utils'

const API_URL = 'https://api.atomic.chat/v1/reminders'
export const REMINDER_TIMEOUT_MS = 15_000

export class EmailReminderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 0
  ) {
    super(`Email reminder request failed (${status})`)
    this.name = 'EmailReminderError'
  }
}

export type ReminderRegistration = {
  email: string
  locale: string
  model_name: string
  app_version?: string
}

async function request(
  token: string,
  method: 'PUT' | 'POST',
  body: ReminderRegistration | { model_name: string }
): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Native HTTP avoids webview-origin differences on desktop and mobile.
    // A browser uses the API's explicit CORS allowlist.
    const transport = isPlatformTauri() ? fetchTauri : fetch
    const response = await Promise.race([
      transport(`${API_URL}${method === 'POST' ? '/notify' : ''}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Email reminder request timed out'))
          controller.abort()
        }, REMINDER_TIMEOUT_MS)
      }),
    ])
    if (response.status !== (method === 'PUT' ? 204 : 202)) {
      const retryAfter = response.headers.get('Retry-After')
      const seconds = retryAfter === null ? NaN : Number(retryAfter)
      const retryAfterMs = Number.isFinite(seconds)
        ? seconds * 1000
        : retryAfter
          ? Date.parse(retryAfter) - Date.now()
          : 0
      // Never expose the response body: validation errors can echo the email.
      throw new EmailReminderError(
        response.status,
        Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

export const registerEmailReminder = (
  token: string,
  registration: ReminderRegistration
): Promise<void> => request(token, 'PUT', registration)

export const notifyEmailReminder = (
  token: string,
  modelName: string
): Promise<void> => request(token, 'POST', { model_name: modelName })
