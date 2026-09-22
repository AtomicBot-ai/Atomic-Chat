/** Minimum engine support is enforced again at the native spawn boundary. */
export const MODERN_IMAGE_ENGINE_TAG = 'master-883-137f740'

const REQUIRES_MODERN_IMAGE_ENGINE = new Set([
  'qwen-image-2.1',
  'krea-2-turbo',
])

export function supportsDiffusionFamily(family: string, tag: string): boolean {
  if (!REQUIRES_MODERN_IMAGE_ENGINE.has(family)) return true
  const match = /^master-(\d+)-(.+)$/.exec(tag)
  return Boolean(match && Number(match[1]) >= 883)
}
