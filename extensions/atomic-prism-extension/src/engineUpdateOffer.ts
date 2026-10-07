/**
 * Producer side of the inference-engine update offer (ATO-528 / ATO-531).
 *
 * A newer PrismML release is *offered*, never downloaded on its own: the
 * decision is published here and the web app's `<EngineUpdateBanner />` turns
 * it into the bottom-right banner. Only the user's "Update" starts a transfer.
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

export interface EngineUpdateOffer {
  provider: string
  currentBackend: string
  targetBackend: string
  currentVersion: string
  targetVersion: string
  downloadSizeBytes?: number
  restartRequired: boolean
  releaseNotesUrl?: string
  /** The one-line note the PrismML manifest carries for the target release. */
  notes?: string
}

/**
 * What the core's update check says about the target release. Every field is
 * optional: the core leaves out what the manifest does not carry.
 */
export interface EngineUpdateDetails {
  notesUrl?: string
  notes?: string
  downloadSize?: number
}

/**
 * Builds the offer for a `current -> target` tag bump. The release page, the
 * note and the size are the core's; nothing is guessed when it has none.
 */
export function buildEngineUpdateOffer(
  providerId: string,
  currentBackend: string,
  targetBackend: string,
  details: EngineUpdateDetails = {}
): EngineUpdateOffer | null {
  const [currentVersion] = currentBackend.split('/')
  const [targetVersion, targetBackendId] = targetBackend.split('/')
  if (!targetVersion || !targetBackendId) return null

  const { notesUrl, notes, downloadSize } = details
  return {
    provider: providerId,
    currentBackend,
    targetBackend,
    currentVersion: currentVersion ?? '',
    targetVersion,
    downloadSizeBytes:
      typeof downloadSize === 'number' && downloadSize > 0
        ? downloadSize
        : undefined,
    // llama.cpp activates through `applyBackendLive()`, which unloads running
    // models and swaps the build in place. No app restart.
    restartRequired: false,
    releaseNotesUrl:
      typeof notesUrl === 'string' && notesUrl ? notesUrl : undefined,
    notes: typeof notes === 'string' && notes ? notes : undefined,
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
