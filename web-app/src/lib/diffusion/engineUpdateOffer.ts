/**
 * The media engine's entry on the shared engine-update banner (ATO-528).
 *
 * The llama.cpp extensions ask their release index whether a newer build
 * exists; the media engine asks the core (`POST /engine-builds/sd-cpp/updates`),
 * which reads conf's sd.cpp manifest and orders the tags. Whatever build the core names for this host is the one users are
 * offered — never upstream's latest, never an older one.
 */

import type { EngineUpdateOffer } from '@/lib/engineUpdateOffer'
import type { EngineBuildUpdateCheck } from '@/services/engine-builds/types'

/** The media engine's provider id on the banner. */
export const MEDIA_ENGINE_PROVIDER = 'sd-cpp'

const UPSTREAM_REPO = 'leejet/stable-diffusion.cpp'
/** Builds with an `-a<rev>` tag come from the fork, which keeps upstream's tag for its releases. */
const FORK_REPO = 'AtomicBot-ai/stable-diffusion.cpp'
const ATOMIC_TAG_SUFFIX_RE = /-a[0-9a-f]{7,}$/

/** Where to read what changed in `tag`. */
export function mediaEngineReleaseNotesUrl(tag: string): string {
  const repo = ATOMIC_TAG_SUFFIX_RE.test(tag) ? FORK_REPO : UPSTREAM_REPO
  return `https://github.com/${repo}/releases/tag/${tag.replace(ATOMIC_TAG_SUFFIX_RE, '')}`
}

/**
 * The offer for moving the active `sd-server` to the build the core named,
 * or null when the core named none. The size is what the core will download,
 * the CUDA runtime companion included.
 */
export function buildMediaEngineUpdateOffer(
  check: EngineBuildUpdateCheck
): EngineUpdateOffer | null {
  const { current, target } = check
  if (!check.update_needed || !current || !target) return null
  return {
    provider: MEDIA_ENGINE_PROVIDER,
    currentBackend: `${current.tag}/${current.backend_id}`,
    targetBackend: `${target.tag}/${target.backend_id}`,
    currentVersion: current.tag,
    targetVersion: target.tag,
    downloadSizeBytes:
      target.download_bytes > 0 ? target.download_bytes : undefined,
    // The core unloads the resident model and swaps the binary on install.
    restartRequired: false,
    releaseNotesUrl: mediaEngineReleaseNotesUrl(target.tag),
  }
}
