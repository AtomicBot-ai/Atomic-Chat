/**
 * The in-app support chat (Help → Chat with us). Messages go to the Atomic
 * Chat support relay, which forwards them to the team's Telegram group and
 * returns the team's replies.
 */

export const DEFAULT_SUPPORT_API_URL = 'https://hatchet.atomic.chat/support'

/**
 * The relay's base URL, without a trailing slash. `VITE_SUPPORT_API_URL`
 * points a dev build at a local relay (`VITE_SUPPORT_API_URL=http://127.0.0.1:8787 yarn dev`).
 */
export const SUPPORT_API_URL: string = (
  (import.meta.env.VITE_SUPPORT_API_URL as string | undefined) ||
  DEFAULT_SUPPORT_API_URL
).replace(/\/+$/, '')

/** The relay rejects longer messages. */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4000

/** Seconds the relay may hold a long poll open before answering empty. */
export const SUPPORT_POLL_WAIT_SECONDS = 25

/** Messages kept on this device; older ones drop off the top. */
export const SUPPORT_MESSAGE_CACHE_LIMIT = 200

/** Longest wait between poll attempts after network errors. */
export const SUPPORT_POLL_MAX_BACKOFF_MS = 60_000

/** Characters of a team reply shown in its OS notification. */
export const SUPPORT_NOTIFICATION_PREVIEW_LENGTH = 100
