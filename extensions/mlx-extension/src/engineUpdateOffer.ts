/**
 * Producer side of the engine update offer for MLX (change
 * move-sdcpp-mlx-install-to-core, design D10).
 *
 * The core compares the active `mlx-server` — the installer's or one it
 * downloaded — with conf's `backends/mlx-manifest.json` by release date, and
 * answers `update_needed` only for a strictly newer build. That answer becomes
 * the shared `<EngineUpdateBanner />` offer; only the user's "Update" installs.
 *
 * The consumer contract (event names, storage key, payload shape) is mirrored
 * in `web-app/src/lib/engineUpdateOffer.ts`. Keep the two in sync.
 */

import type { CoreEngineBuildUpdateCheck } from '../../shared/atomicCoreRuntime'

/** @see web-app/src/lib/engineUpdateOffer.ts */
export const ENGINE_UPDATE_AVAILABLE_EVENT = 'app:engine-update-available'
/** @see web-app/src/lib/engineUpdateOffer.ts */
export const ENGINE_UPDATE_RETRACTED_EVENT = 'app:engine-update-retracted'

/** @see web-app/src/lib/engineUpdateOffer.ts */
export const engineUpdateOfferKey = (providerId: string): string =>
  `atomic_engine_update_offer_${providerId}`

export const MLX_PROVIDER = 'mlx'

/** The fork's release page for a build. */
const MLX_RELEASE_TAG_BASE = 'https://github.com/AtomicBot-ai/mlx-vlm/releases/tag'

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

/** The offer for the build the core named, or null when it named none. */
export function buildMlxEngineUpdateOffer(
  check: CoreEngineBuildUpdateCheck
): EngineUpdateOffer | null {
  const { current, target } = check
  if (!check.update_needed || !current || !target) return null
  return {
    provider: MLX_PROVIDER,
    currentBackend: `${current.tag}/${current.backend_id}`,
    targetBackend: `${target.tag}/${target.backend_id}`,
    currentVersion: current.tag,
    targetVersion: target.tag,
    downloadSizeBytes: target.download_bytes > 0 ? target.download_bytes : undefined,
    // The core unloads MLX sessions of the old build when it installs the new one.
    restartRequired: false,
    releaseNotesUrl: `${MLX_RELEASE_TAG_BASE}/${encodeURIComponent(target.tag)}`,
  }
}

/** Persists the offer and announces it. Best-effort on both legs. */
export function publishEngineUpdateOffer(offer: EngineUpdateOffer): void {
  try {
    localStorage.setItem(engineUpdateOfferKey(offer.provider), JSON.stringify(offer))
  } catch {
    // Storage unavailable: the event below still reaches a mounted banner.
  }
  window.dispatchEvent(new CustomEvent(ENGINE_UPDATE_AVAILABLE_EVENT, { detail: offer }))
}

/** Withdraws the offer: the core no longer names a newer build. */
export function retractEngineUpdateOffer(providerId: string): void {
  try {
    localStorage.removeItem(engineUpdateOfferKey(providerId))
  } catch {
    // Nothing stored to withdraw.
  }
  window.dispatchEvent(new CustomEvent(ENGINE_UPDATE_RETRACTED_EVENT, { detail: providerId }))
}
