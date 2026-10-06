/**
 * The media engine's entry on the shared engine-update banner (ATO-528).
 *
 * The llama.cpp extensions ask their release index whether a newer build
 * exists; the media engine asks `atomic-chat-conf/backends/sdcpp-manifest.json`
 * the same question through `checkEngineUpdate()`. Whatever tag that manifest
 * names for this host is the build users are offered — never upstream's latest.
 */

import type { EngineUpdateOffer } from '@/lib/engineUpdateOffer'
import { companionFor } from '@/services/diffusion/backendMatrix'
import {
  DEFAULT_UPSTREAM_REPO,
  stripAtomicTagSuffix,
  type SdcppManifest,
} from '@/services/diffusion/install'

/** The media engine's provider id on the banner. */
export const MEDIA_ENGINE_PROVIDER = 'sd-cpp'

/**
 * The offer for moving the installed `sd-server` to the manifest's tag. The
 * size counts the companion runtime too: a new tag installs into a directory
 * of its own, so `ensureDiffusionBackend()` downloads that archive again.
 */
export function buildMediaEngineUpdateOffer(
  installed: { tag: string; backendId: string },
  hostBackendId: string,
  manifest: SdcppManifest
): EngineUpdateOffer {
  const sizeOf = (backendId: string | null): number =>
    (backendId &&
      manifest.assets.find((asset) => asset.backend === backendId)?.size) ||
    0
  const archiveSize = sizeOf(hostBackendId)
  const repo = manifest.upstream_repo ?? DEFAULT_UPSTREAM_REPO

  return {
    provider: MEDIA_ENGINE_PROVIDER,
    currentBackend: `${installed.tag}/${installed.backendId}`,
    targetBackend: `${manifest.tag_name}/${hostBackendId}`,
    currentVersion: installed.tag,
    targetVersion: manifest.tag_name,
    downloadSizeBytes:
      archiveSize > 0
        ? archiveSize + sizeOf(companionFor(hostBackendId))
        : undefined,
    // `updateEngine()` unloads the resident model and swaps the binary.
    restartRequired: false,
    releaseNotesUrl: `https://github.com/${repo}/releases/tag/${stripAtomicTagSuffix(
      manifest.tag_name
    )}`,
  }
}
