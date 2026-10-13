/**
 * The inference-engine update offer on the shared banner (ATO-528 / ATO-531),
 * built from the core's answer about every engine (`POST /engines/versions`,
 * spec `engine-lifecycle-desktop`). The core alone decides whether an update
 * is needed and to what: an offer exists exactly when the engine's
 * `update.needed` is `true`, and a `blocked_reason` is never turned into one.
 * The app compares no versions.
 *
 * What stays in the app is the user's answer to an offer: "Remind me later"
 * (a day) and the × (never for this target), kept per engine in
 * `localStorage` and bound to the target, so the next release always gets a
 * fresh hearing.
 */

import type {
  EngineId,
  EngineUpdateApply,
  EngineVersions,
} from '@/services/engines/types'

/**
 * Engines that can offer an update, most-preferred first. The llama.cpp
 * providers ship side by side and only one banner may be on screen, so the
 * default provider's offer wins and the others wait. MLX follows them; the
 * media engine comes after: a chat engine is what most sessions use. The
 * managed engines, whose update is a reinstall the user confirms on their
 * page, come last.
 */
export const ENGINE_UPDATE_ORDER: readonly EngineId[] = [
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'mlx',
  'sd-cpp',
  'tensorrt-llm',
  'vllm',
]

/** One entry per engine; a newer target replaces the previous decision. */
const ENGINE_UPDATE_SNOOZE_KEY = 'atomic-engine-update-snooze'

/** Offers the extensions and the image store persisted before the core made them. */
const LEGACY_OFFER_KEY_PREFIX = 'atomic_engine_update_offer_'

/** How long "Remind me later" keeps the engine banner down. */
export const ENGINE_UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000

export interface EngineUpdateOffer {
  /** The engine, e.g. `llamacpp-upstream`. Names it to the user. */
  provider: EngineId
  /** Full `version/variant` pair active now. */
  currentBackend: string
  /** Full `version/variant` pair being offered. */
  targetBackend: string
  /** Version active now, e.g. `b10840`. */
  currentVersion: string
  /** Version being offered, e.g. `b10909`. */
  targetVersion: string
  /** Every archive or image layer the update downloads, when the core knows it. */
  downloadSizeBytes?: number
  /** `swap` — the core installs and switches in place; `reinstall` — confirmed on the engine's page. */
  apply: EngineUpdateApply
  /** Whether the app must restart to pick the build up; no engine needs it today. */
  restartRequired: boolean
  /** Release page for "Show what's new". Absent renders no link. */
  releaseNotesUrl?: string
  /** One line about the target release. Absent renders no changelog block. */
  notes?: string
}

const GGML_ORG_RELEASE_TAG_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/tag'
const TURBOQUANT_RELEASE_TAG_BASE =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag'
const MLX_RELEASE_TAG_BASE =
  'https://github.com/AtomicBot-ai/mlx-vlm/releases/tag'
const SD_UPSTREAM_REPO = 'leejet/stable-diffusion.cpp'
/** sd.cpp builds with an `-a<rev>` tag come from the fork, which keeps upstream's tag for its releases. */
const SD_FORK_REPO = 'AtomicBot-ai/stable-diffusion.cpp'
const SD_ATOMIC_TAG_SUFFIX_RE = /-a[0-9a-f]{7,}$/

/**
 * Where to read what changed in `version`, for the engines whose release page
 * follows from the tag alone. PrismML's page and note come from its own
 * manifest, and a managed engine's release is a conf descriptor: neither is in
 * the core's answer, so they get no link.
 */
export function engineReleaseNotesUrl(
  engine: EngineId,
  version: string
): string | undefined {
  switch (engine) {
    case 'llamacpp-upstream':
      return `${GGML_ORG_RELEASE_TAG_BASE}/${encodeURIComponent(version)}`
    case 'llamacpp':
      return `${TURBOQUANT_RELEASE_TAG_BASE}/${encodeURIComponent(version)}`
    case 'mlx':
      return `${MLX_RELEASE_TAG_BASE}/${encodeURIComponent(version)}`
    case 'sd-cpp': {
      const repo = SD_ATOMIC_TAG_SUFFIX_RE.test(version)
        ? SD_FORK_REPO
        : SD_UPSTREAM_REPO
      return `https://github.com/${repo}/releases/tag/${version.replace(SD_ATOMIC_TAG_SUFFIX_RE, '')}`
    }
    default:
      return undefined
  }
}

/** The offer the core makes for one engine, or `null` when it makes none. */
export function engineUpdateOfferFrom(
  versions: EngineVersions
): EngineUpdateOffer | null {
  const { active, update } = versions
  const target = update.target
  if (!update.needed || !target || !active) return null
  return {
    provider: versions.engine,
    currentBackend: `${active.version}/${active.variant}`,
    targetBackend: `${target.version}/${target.variant}`,
    currentVersion: active.version,
    targetVersion: target.version,
    downloadSizeBytes:
      target.download_bytes && target.download_bytes > 0
        ? target.download_bytes
        : undefined,
    apply: update.apply,
    // A swap unloads the engine's models and switches in place; a reinstall
    // is followed on the engine's page.
    restartRequired: false,
    releaseNotesUrl: engineReleaseNotesUrl(versions.engine, target.version),
  }
}

/**
 * Drop the offers earlier versions of the app persisted. The core is the only
 * source now; a stale record would otherwise sit in storage forever.
 */
export function clearLegacyEngineUpdateOffers(): void {
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LEGACY_OFFER_KEY_PREFIX)) stale.push(key)
    }
    stale.forEach((key) => localStorage.removeItem(key))
  } catch {
    // Storage unavailable: nothing was persisted either.
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
