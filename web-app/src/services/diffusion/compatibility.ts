/** Minimum engine support is enforced again at the native spawn boundary. */
export const MODERN_IMAGE_ENGINE_TAG = 'master-883-137f740'
/** The first upstream build that runs FLUX.3 Image Klein (leejet/stable-diffusion.cpp#2143). */
export const FLUX3_IMAGE_ENGINE_TAG = 'master-968-8cd731e'

const REQUIRED_ENGINE_TAGS: ReadonlyMap<string, string> = new Map([
  ['qwen-image-2.1', MODERN_IMAGE_ENGINE_TAG],
  ['qwen-image-2.1-turbo', MODERN_IMAGE_ENGINE_TAG],
  ['krea-2-turbo', MODERN_IMAGE_ENGINE_TAG],
  ['flux.3-klein', FLUX3_IMAGE_ENGINE_TAG],
])

function buildOf(tag: string): number | null {
  const match = /^master-(\d+)-(.+)$/.exec(tag)
  return match ? Number(match[1]) : null
}

/** The oldest engine `family` loads on; `null` when any engine serves it. */
export function requiredEngineTag(family: string): string | null {
  return REQUIRED_ENGINE_TAGS.get(family) ?? null
}

export function supportsDiffusionFamily(family: string, tag: string): boolean {
  const required = requiredEngineTag(family)
  if (!required) return true
  const build = buildOf(tag)
  return build !== null && build >= (buildOf(required) ?? Infinity)
}
