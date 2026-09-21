/** Minimum engine support is enforced again at the native spawn boundary. */
export const QWEN_IMAGE_2_1_ENGINE_TAG = 'master-883-137f740'

export function supportsDiffusionFamily(family: string, tag: string): boolean {
  if (family !== 'qwen-image-2.1') return true
  const match = /^master-(\d+)-(.+)$/.exec(tag)
  return Boolean(match && Number(match[1]) >= 883)
}
