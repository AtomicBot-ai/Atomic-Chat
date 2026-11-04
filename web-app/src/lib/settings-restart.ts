/**
 * Restarts of a loaded local model that the user's own settings change set
 * off: a new context size or Fit to device memory in Run settings, another
 * load-time option of the model, or an engine setting on its Providers page.
 *
 * Such a restart stops the engine under a turn that may still be answering,
 * and that turn then fails like any engine that went away. The chat's error
 * card reads the marker left here to say that the settings change restarted
 * the model, instead of only "The model engine stopped" (design review D7).
 *
 * The marker lives in memory only: a restart belongs to this run of the app.
 */

export type SettingsRestart = {
  providerId: string
  modelId: string
  startedAt: number
  /** When the restart finished, loaded or not; unset while it runs. */
  settledAt?: number
}

/** How long after a restart finished a turn that fails still counts as cut off by it. */
export const SETTINGS_RESTART_GRACE_MS = 15_000
/**
 * The longest a restart that has not finished is held responsible. A cold
 * load of a large model is slow; a restart that never reports back is not
 * one any more.
 */
export const SETTINGS_RESTART_MAX_MS = 5 * 60_000
/** Failed turns remembered as cut off by a restart (their card keeps saying so). */
const BLAMED_TURNS_LIMIT = 50

type Clock = () => number

const restarts = new Map<string, SettingsRestart>()
/** When each failure was first seen, so one older than a restart is never blamed on it. */
const errorFirstSeen = new WeakMap<object, number>()
const blamedErrors = new WeakSet<object>()
const blamedTurns = new Set<string>()

const keyOf = (providerId: string, modelId: string) =>
  `${providerId}\u0000${modelId}`

/**
 * Marks the start of a restart a settings change set off. Returns the
 * function that marks its end; call it whether the restart worked or not.
 */
export function beginSettingsRestart(
  providerId: string,
  modelId: string,
  now: Clock = Date.now
): () => void {
  const entry: SettingsRestart = { providerId, modelId, startedAt: now() }
  restarts.set(keyOf(providerId, modelId), entry)
  return () => {
    entry.settledAt = now()
  }
}

/** Runs `restart` with its marker set for the time it takes and the grace after. */
export async function trackSettingsRestart<T>(
  providerId: string,
  modelId: string,
  restart: () => Promise<T>
): Promise<T> {
  const settle = beginSettingsRestart(providerId, modelId)
  try {
    return await restart()
  } finally {
    settle()
  }
}

/** The settings restart of `modelId` still fresh at `now`, if any; an expired one is dropped. */
export function activeSettingsRestart(
  providerId: string,
  modelId: string,
  now: number = Date.now()
): SettingsRestart | undefined {
  const key = keyOf(providerId, modelId)
  const entry = restarts.get(key)
  if (!entry) return undefined
  const expired =
    entry.settledAt !== undefined
      ? now - entry.settledAt > SETTINGS_RESTART_GRACE_MS
      : now - entry.startedAt > SETTINGS_RESTART_MAX_MS
  if (expired) {
    restarts.delete(key)
    return undefined
  }
  return entry
}

/** Forgets the restart marker of `modelId`, once a card has been acted on. */
export function clearSettingsRestart(providerId: string, modelId: string) {
  restarts.delete(keyOf(providerId, modelId))
}

function rememberBlame(error: object, failedMessageId: string | undefined) {
  blamedErrors.add(error)
  if (!failedMessageId || blamedTurns.has(failedMessageId)) return
  blamedTurns.add(failedMessageId)
  if (blamedTurns.size > BLAMED_TURNS_LIMIT) {
    const oldest = blamedTurns.values().next().value
    if (oldest !== undefined) blamedTurns.delete(oldest)
  }
}

/**
 * Whether the failure the chat shows was cut off by a restart a settings
 * change set off.
 *
 * - `live`: the error the turn just failed with (not one rebuilt from a
 *   stored failed turn). Only a live error that was first seen after the
 *   restart began is blamed on it, and only while the restart is fresh.
 * - `eligible`: the failure is one a restart explains (the engine went away,
 *   or an unclassified error from a local engine); a context overflow or an
 *   out-of-memory answer keeps its own guidance.
 *
 * Once blamed, the error and its stored turn stay blamed, so the card keeps
 * its words after the window passes or the page re-renders the stored turn.
 */
export function blameSettingsRestart({
  error,
  live,
  failedMessageId,
  providerId,
  modelId,
  eligible,
  now = Date.now(),
}: {
  error: object
  live: boolean
  failedMessageId: string | undefined
  providerId: string | undefined
  modelId: string | undefined
  eligible: boolean
  now?: number
}): boolean {
  if (
    blamedErrors.has(error) ||
    (failedMessageId !== undefined && blamedTurns.has(failedMessageId))
  ) {
    rememberBlame(error, failedMessageId)
    return true
  }
  if (!live) return false
  let firstSeen = errorFirstSeen.get(error)
  if (firstSeen === undefined) {
    firstSeen = now
    errorFirstSeen.set(error, now)
  }
  if (!eligible || !providerId || !modelId) return false
  const restart = activeSettingsRestart(providerId, modelId, now)
  if (!restart || firstSeen < restart.startedAt) return false
  rememberBlame(error, failedMessageId)
  return true
}

/** Test helper: forgets every marker and every blamed turn. */
export function resetSettingsRestartsForTest() {
  restarts.clear()
  blamedTurns.clear()
}
