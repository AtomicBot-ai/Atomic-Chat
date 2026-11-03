import { ENGINE_IDS } from '@/services/engines/types'
import { getProviderTitle } from '@/lib/utils'

export type EngineDownloadLabel = {
  /** The engine, as the app names it ("llama.cpp", "stable-diffusion.cpp"). */
  name: string
  /** The build being fetched, when the task id carries it. */
  version?: string
}

const LLAMACPP_BACKEND_PREFIX = 'llamacpp-backend-'
const DIFFUSION_BACKEND_PREFIX = 'diffusion-backend-'
const ENGINE_UPDATE_PREFIX = 'engine-update-'
const ENGINE_BUILD_PREFIX = 'engine-build-'

// Longest first, so `llamacpp-upstream-…` is not read as `llamacpp` + `upstream-…`.
const ENGINES_BY_LENGTH = [...ENGINE_IDS].sort((a, b) => b.length - a.length)

/**
 * Where a build id stops naming the release and starts naming the host:
 * `b6123-macos-arm64`, `master-883-137f740-a36f1b1a-win-cuda-12-x64`.
 */
const HOST_SUFFIX = /-(?:macos|win|windows|linux|ubuntu)(?:-|$)/

const releaseOf = (build: string): string | undefined => {
  const cut = build.search(HOST_SUFFIX)
  const release = cut > 0 ? build.slice(0, cut) : build
  return release || undefined
}

/** `<engine>-<rest>` for any engine the core answers for. */
function splitEngine(rest: string): { engine: string; build: string } | null {
  const engine = ENGINES_BY_LENGTH.find((id) => rest.startsWith(`${id}-`))
  return engine ? { engine, build: rest.slice(engine.length + 1) } : null
}

/**
 * What the download panel calls an engine build it is fetching, from the
 * task id alone: the engine's name and the release, so a row reads
 * "llama.cpp · b11463" instead of `llamacpp-backend-b11463/macos-arm64`.
 * `null` for anything that is not an engine build.
 *
 * The ids are the ones the installers send: the llama.cpp extensions'
 * `llamacpp-backend-<version>/<backend>` (all three share the prefix, so the
 * row names llama.cpp), the core's `engine-update-<engine>-<version>` and
 * `engine-build-<engine>-<tag>`, and the media engine's
 * `diffusion-backend-<tag>-<backend>`.
 */
export function engineDownloadLabel(id: string): EngineDownloadLabel | null {
  if (id.startsWith(LLAMACPP_BACKEND_PREFIX)) {
    const build = id.slice(LLAMACPP_BACKEND_PREFIX.length)
    const slash = build.indexOf('/')
    return {
      name: getProviderTitle('llamacpp-upstream'),
      version: slash > 0 ? build.slice(0, slash) : releaseOf(build),
    }
  }
  if (id.startsWith(DIFFUSION_BACKEND_PREFIX)) {
    return {
      name: getProviderTitle('sd-cpp'),
      version: releaseOf(id.slice(DIFFUSION_BACKEND_PREFIX.length)),
    }
  }
  for (const prefix of [ENGINE_UPDATE_PREFIX, ENGINE_BUILD_PREFIX]) {
    if (!id.startsWith(prefix)) continue
    const parts = splitEngine(id.slice(prefix.length))
    if (!parts) return null
    return {
      name: getProviderTitle(parts.engine),
      version: releaseOf(parts.build),
    }
  }
  return null
}
