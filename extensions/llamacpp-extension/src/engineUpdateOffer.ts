/**
 * Producer side of the inference-engine update offer (ATO-528 / ATO-531).
 *
 * Until this existed, `reconcileBackendReleaseTag()` downloaded every new
 * release tag on its own at startup — several hundred megabytes, unannounced.
 * Now a tag bump is *offered*: the decision is published here and the web app's
 * `<EngineUpdateBanner />` turns it into the bottom-right banner. Only the
 * user's "Update" starts a transfer.
 *
 * The consumer contract (event name, storage key, payload shape) is mirrored in
 * `web-app/src/lib/engineUpdateOffer.ts`. Keep the two in sync. It travels on
 * the DOM `window` rather than the `@janhq/core` bus for the same reason
 * `app:backend-hotswapped` does: an extension that bundles its own copy of
 * core bypasses the in-process EventEmitter singleton, and this is pure UI.
 */

/** @see web-app/src/lib/engineUpdateOffer.ts */
export const ENGINE_UPDATE_AVAILABLE_EVENT = 'app:engine-update-available'

/** @see web-app/src/lib/engineUpdateOffer.ts */
export const engineUpdateOfferKey = (providerId: string): string =>
  `atomic_engine_update_offer_${providerId}`

/** Release page the TurboQuant fork publishes each `b<build>-<semver>` tag on. */
const TURBOQUANT_RELEASE_TAG_BASE =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag'

export interface EngineUpdateOffer {
  provider: string
  currentBackend: string
  targetBackend: string
  currentVersion: string
  targetVersion: string
  downloadSizeBytes?: number
  restartRequired: boolean
  releaseNotesUrl?: string
}

export function engineReleaseNotesUrl(version: string): string {
  return `${TURBOQUANT_RELEASE_TAG_BASE}/${encodeURIComponent(version)}`
}

/**
 * Builds the offer for a `current -> target` tag bump.
 *
 * `resolveSize` is injected so the caller keeps ownership of the (async,
 * network-touching) archive lookup and this stays trivially testable. A
 * throwing or empty resolver only costs the size line in the banner.
 */
export async function buildEngineUpdateOffer(
  providerId: string,
  currentBackend: string,
  targetBackend: string,
  resolveSize: (version: string, backend: string) => Promise<number | undefined>
): Promise<EngineUpdateOffer | null> {
  const [currentVersion] = currentBackend.split('/')
  const [targetVersion, targetBackendId] = targetBackend.split('/')
  if (!targetVersion || !targetBackendId) return null

  let downloadSizeBytes: number | undefined
  try {
    downloadSizeBytes = await resolveSize(targetVersion, targetBackendId)
  } catch {
    downloadSizeBytes = undefined
  }

  return {
    provider: providerId,
    currentBackend,
    targetBackend,
    currentVersion: currentVersion ?? '',
    targetVersion,
    downloadSizeBytes:
      typeof downloadSizeBytes === 'number' && downloadSizeBytes > 0
        ? downloadSizeBytes
        : undefined,
    // llama.cpp activates through `applyBackendLive()`, which unloads running
    // models and swaps the build in place. No app restart.
    restartRequired: false,
    releaseNotesUrl: engineReleaseNotesUrl(targetVersion),
  }
}

/** Persists the offer and announces it. Best-effort on both legs. */
export function publishEngineUpdateOffer(offer: EngineUpdateOffer): void {
  try {
    localStorage.setItem(
      engineUpdateOfferKey(offer.provider),
      JSON.stringify(offer)
    )
  } catch {
    // Storage unavailable: the event below still reaches a mounted banner.
  }

  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(
      new CustomEvent(ENGINE_UPDATE_AVAILABLE_EVENT, { detail: offer })
    )
  }
}

/** Retracts a pending offer — the tag bump is done, or no longer true. */
export function clearEngineUpdateOffer(providerId: string): void {
  try {
    localStorage.removeItem(engineUpdateOfferKey(providerId))
  } catch {
    // Nothing to do: a stale offer is dropped by the banner's own re-check.
  }
}
