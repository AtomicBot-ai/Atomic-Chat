import { useEffect, useRef, useState } from 'react'

import {
  SUPPORT_NOTIFICATION_PREVIEW_LENGTH,
  SUPPORT_POLL_MAX_BACKOFF_MS,
  SUPPORT_POLL_WAIT_SECONDS,
} from '@/constants/support'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  desktopNotificationsEnabled,
  isWindowAway,
  showDesktopNotification,
} from '@/lib/notifications'
import {
  isSupportApiError,
  markRead,
  pollMessages,
  type SupportPollResult,
} from '@/services/support/client'
import {
  selectMaxTeamSeq,
  useSupportChatStore,
  type SupportChatMessage,
} from '@/stores/support-chat-store'

const INITIAL_BACKOFF_MS = 1000

/**
 * A relay that answers an empty poll at once (no long-poll support, or a proxy
 * that cuts the request short) must not be asked again in a tight loop.
 */
const MIN_EMPTY_POLL_INTERVAL_MS = 2000

/** On top of `wait`: a poll that has not answered by then is given up. */
const POLL_TIMEOUT_SLACK_MS = 10_000

/** One line, at most `SUPPORT_NOTIFICATION_PREVIEW_LENGTH` characters. */
export const supportNotificationPreview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUPPORT_NOTIFICATION_PREVIEW_LENGTH
    ? `${flat.slice(0, SUPPORT_NOTIFICATION_PREVIEW_LENGTH - 1).trimEnd()}…`
    : flat
}

const abortError = (): Error =>
  Object.assign(new Error('Aborted'), { name: 'AbortError' })

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * One long poll, given up when the loop stops or the relay takes longer than
 * it promised. Settles on its own rather than trusting the request to honour
 * the abort, which the Tauri HTTP plugin does not always do.
 */
const pollOnce = (
  token: string,
  after: number,
  stop: AbortSignal
): Promise<SupportPollResult> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  stop.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    abort,
    SUPPORT_POLL_WAIT_SECONDS * 1000 + POLL_TIMEOUT_SLACK_MS
  )
  return new Promise<SupportPollResult>((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortError()), {
      once: true,
    })
    pollMessages(
      token,
      { after, wait: SUPPORT_POLL_WAIT_SECONDS },
      { signal: controller.signal }
    ).then(resolve, reject)
  }).finally(() => {
    clearTimeout(timer)
    stop.removeEventListener('abort', abort)
  })
}

/**
 * Keeps the support chat in step with the relay for the whole session, so a
 * reply reaches the user with the chat closed.
 *
 * - Long-polls while a conversation exists; backs off exponentially (up to a
 *   minute) while the relay cannot be reached, and forgets the conversation
 *   when the relay refuses its token.
 * - A new reply from the team raises an OS notification unless the chat is
 *   open in a focused window (and the Settings switch allows notifications).
 * - While the chat is open in a focused window, the team's messages are
 *   reported read; opening the chat or coming back to the window does it too.
 *
 * Mounted once at the app root.
 */
export function useSupportChatSync(): void {
  const { t } = useTranslation()
  const token = useSupportChatStore((state) => state.token)
  const sheetOpen = useSupportChatStore((state) => state.sheetOpen)
  const maxTeamSeq = useSupportChatStore(selectMaxTeamSeq)
  const lastReadSeq = useSupportChatStore((state) => state.lastReadSeq)
  // Bumped when the window comes back, to re-check what is unread.
  const [windowReturns, setWindowReturns] = useState(0)

  // A new `t` identity must not restart the poll.
  const translate = useRef(t)
  translate.current = t

  useEffect(() => {
    if (!token) return
    const stop = new AbortController()
    const { signal } = stop

    const announce = (fresh: SupportChatMessage[]) => {
      if (fresh.length === 0) return
      const watching =
        useSupportChatStore.getState().sheetOpen && !isWindowAway()
      if (watching || !desktopNotificationsEnabled()) return
      const title = translate.current('common:support.teamName')
      for (const message of fresh) {
        void showDesktopNotification(
          title,
          supportNotificationPreview(message.text)
        )
      }
    }

    const run = async () => {
      let backoff = 0
      while (!signal.aborted) {
        const startedAt = Date.now()
        try {
          const after = useSupportChatStore.getState().lastSeq
          const result = await pollOnce(token, after, signal)
          if (signal.aborted) return
          // The conversation was replaced while this poll was out.
          if (useSupportChatStore.getState().token !== token) return
          backoff = 0
          announce(
            useSupportChatStore.getState().applyServerMessages(result.messages)
          )
          if (
            result.messages.length === 0 &&
            Date.now() - startedAt < MIN_EMPTY_POLL_INTERVAL_MS
          )
            await sleep(MIN_EMPTY_POLL_INTERVAL_MS, signal)
        } catch (error) {
          if (signal.aborted) return
          if (isSupportApiError(error, 'unauthorized')) {
            const state = useSupportChatStore.getState()
            if (state.token === token) state.resetConversation()
            return
          }
          backoff = backoff
            ? Math.min(backoff * 2, SUPPORT_POLL_MAX_BACKOFF_MS)
            : INITIAL_BACKOFF_MS
          console.warn(
            `[support] poll failed, retrying in ${backoff} ms:`,
            error instanceof Error ? error.message : error
          )
          await sleep(backoff, signal)
        }
      }
    }
    void run()

    return () => stop.abort()
  }, [token])

  useEffect(() => {
    const returned = () => setWindowReturns((n) => n + 1)
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
    return () => {
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
    }
  }, [])

  // The seq a read report is out for, so one is not sent twice.
  const reporting = useRef(0)
  useEffect(() => {
    if (!token || !sheetOpen) return
    if (maxTeamSeq <= lastReadSeq || reporting.current >= maxTeamSeq) return
    if (isWindowAway()) return
    const seq = maxTeamSeq
    reporting.current = seq
    markRead(token, seq)
      .then(() => {
        const state = useSupportChatStore.getState()
        if (state.token === token) state.setLastReadSeq(seq)
      })
      .catch((error) => {
        console.warn(
          '[support] read report failed:',
          error instanceof Error ? error.message : error
        )
      })
      .finally(() => {
        if (reporting.current === seq) reporting.current = 0
      })
  }, [token, sheetOpen, maxTeamSeq, lastReadSeq, windowReturns])
}
