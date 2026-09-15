/**
 * Contract for the inference-engine update offer (ATO-528 / ATO-531).
 *
 * The producer side lives in the llama.cpp extensions, which bundle their own
 * copy of `@janhq/core` and cannot import from the web app — so the event name
 * and the storage keys below are duplicated there as literals. Keep the two
 * sides in sync:
 *   - `extensions/llamacpp-extension/src/engineUpdateOffer.ts`
 *   - `extensions/llamacpp-upstream-extension/src/engineUpdateOffer.ts`
 *
 * A DOM `CustomEvent` rather than the `@janhq/core` bus, for the same reason
 * `app:backend-hotswapped` is one: the in-process EventEmitter singleton is
 * bypassed when an extension bundles its own core copy, and this event only
 * drives UI.
 */

/** Dispatched on `window` with an {@link EngineUpdateOffer} as its detail. */
export const ENGINE_UPDATE_AVAILABLE_EVENT = 'app:engine-update-available'

/**
 * Per-provider mirror of the last offer, written before the event is
 * dispatched. Extensions load after React mounts *and* can finish their
 * release-tag reconciliation before it, so the banner reads this on mount
 * instead of relying on catching the event — the same race the better-backend
 * recommendation solves this way.
 */
export const engineUpdateOfferKey = (providerId: string): string =>
  `atomic_engine_update_offer_${providerId}`

/** One entry per provider; a newer target replaces the previous decision. */
const ENGINE_UPDATE_SNOOZE_KEY = 'atomic-engine-update-snooze'

/** How long "Remind me later" keeps the engine banner down. */
export const ENGINE_UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000

export interface EngineUpdateOffer {
  /** Provider id, e.g. `llamacpp-upstream`. Names the engine to the user. */
  provider: string
  /** Full `version/backend` pair currently configured. */
  currentBackend: string
  /** Full `version/backend` pair being offered. */
  targetBackend: string
  /** Release tag currently in use, e.g. `b10840`. */
  currentVersion: string
  /** Release tag being offered, e.g. `b10909-mix-bea84f7`. */
  targetVersion: string
  /** Archive size in bytes when the release index knows it. */
  downloadSizeBytes?: number
  /**
   * Whether the app must restart to pick the build up. `false` for llama.cpp,
   * which hot-swaps (`applyBackendLive`); carried explicitly so an engine that
   * cannot hot-swap can say so without a UI change.
   */
  restartRequired: boolean
  /** Release page for "Show what's new". Absent renders no link. */
  releaseNotesUrl?: string
}

function isOffer(value: unknown): value is EngineUpdateOffer {
  if (!value || typeof value !== 'object') return false
  const offer = value as Partial<EngineUpdateOffer>
  return (
    typeof offer.provider === 'string' &&
    !!offer.provider &&
    typeof offer.targetBackend === 'string' &&
    !!offer.targetBackend &&
    typeof offer.targetVersion === 'string' &&
    !!offer.targetVersion
  )
}

/** Reads the offer an extension persisted for `providerId`, if any. */
export function readEngineUpdateOffer(
  providerId: string
): EngineUpdateOffer | null {
  try {
    const raw = localStorage.getItem(engineUpdateOfferKey(providerId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isOffer(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Drops the offer once it has been accepted or is no longer true. */
export function clearEngineUpdateOffer(providerId: string): void {
  try {
    localStorage.removeItem(engineUpdateOfferKey(providerId))
  } catch {
    // Storage unavailable: the offer simply returns next launch.
  }
}

/**
 * `until: null` means "never again for this target" — what the × does. A
 * number is an epoch ms deadline, which is what "Remind me later" writes.
 */
type SnoozeRecord = { target: string; until: number | null }

function readSnoozeMap(): Record<string, SnoozeRecord> {
  try {
    const raw = localStorage.getItem(ENGINE_UPDATE_SNOOZE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, SnoozeRecord>)
      : {}
  } catch {
    return {}
  }
}

function writeSnooze(providerId: string, record: SnoozeRecord): void {
  try {
    const map = readSnoozeMap()
    map[providerId] = record
    localStorage.setItem(ENGINE_UPDATE_SNOOZE_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable: worst case the banner comes back sooner.
  }
}

/**
 * Whether the user has already put this exact target away. Bound to the target
 * pair, so the next engine release always gets a fresh hearing.
 */
export function isEngineUpdateSnoozed(
  offer: EngineUpdateOffer,
  now: number = Date.now()
): boolean {
  const record = readSnoozeMap()[offer.provider]
  if (!record || record.target !== offer.targetBackend) return false
  if (record.until === null) return true
  return Number.isFinite(record.until) && record.until > now
}

/** "Remind me later" — back in {@link ENGINE_UPDATE_SNOOZE_MS}. */
export function snoozeEngineUpdate(
  offer: EngineUpdateOffer,
  now: number = Date.now()
): void {
  writeSnooze(offer.provider, {
    target: offer.targetBackend,
    until: now + ENGINE_UPDATE_SNOOZE_MS,
  })
}

/** The × — this build is not coming back; a newer one still will. */
export function dismissEngineUpdate(offer: EngineUpdateOffer): void {
  writeSnooze(offer.provider, { target: offer.targetBackend, until: null })
}
