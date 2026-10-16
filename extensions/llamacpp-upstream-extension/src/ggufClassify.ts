/**
 * Which GGUFs are chat models. Mirrors `classify` in
 * src-tauri/src/core/app/gguf_scan.rs (the folder scan runs there); this copy
 * guards the import path, which reads metadata through the plugin.
 */

const DIFFUSION_ARCHES = [
  'wan',
  'flux',
  'qwen_image',
  'sd1',
  'sd2',
  'sd3',
  'sdxl',
  'hidream',
  'hunyuan_video',
  'hyvid',
  'ltxv',
  'lumina2',
  'aura',
  'chroma',
  'cosmos',
  'mochi',
  'pixart',
  'kontext',
]

/** Why an architecture is not a chat model, or undefined when it may be one. */
export function nonChatReason(arch: string): string | undefined {
  const a = arch.toLowerCase()
  if (
    DIFFUSION_ARCHES.some((d) => a === d || a.startsWith(`${d}_`)) ||
    a.includes('diffusion') ||
    a.includes('unet')
  ) {
    return 'diffusion/image-video model (not a chat model)'
  }
  if (a.startsWith('clip') || a === 'siglip') {
    return 'vision encoder / projector (CLIP)'
  }
  if (['t5', 'umt5', 't5encoder', 't5_encoder', 'mt5'].includes(a)) {
    return 'text encoder for diffusion pipelines (T5)'
  }
  if (a === 'vae' || a.endsWith('_vae') || a.startsWith('vae')) {
    return 'VAE (image/video decoder)'
  }
  if (['whisper', 'encodec', 'wavtokenizer-dec', 'snac'].includes(a)) {
    return 'audio codec / encoder'
  }
  return undefined
}

export function isMmprojFileName(fileName: string): boolean {
  const l = fileName.toLowerCase()
  return l.includes('mmproj') || l.includes('projector')
}

export type GgufChatCheck =
  | { chat: true }
  | { chat: false; reason: string }

/** Classify from GGUF metadata (string map as the plugin returns it). */
export function checkChatModel(
  metadata: Record<string, string | undefined> | undefined,
  fileName = ''
): GgufChatCheck {
  const arch = metadata?.['general.architecture']?.trim() ?? ''
  if (isMmprojFileName(fileName)) {
    return { chat: false, reason: 'mmproj projector, not a chat model' }
  }
  if (!arch) {
    return { chat: false, reason: 'no general.architecture in header' }
  }
  const reason = nonChatReason(arch)
  if (reason) return { chat: false, reason: `${reason}: architecture '${arch}'` }
  if (!metadata?.[`${arch}.context_length`]) {
    return {
      chat: false,
      reason: `architecture '${arch}' has no context length (not a language model)`,
    }
  }
  return { chat: true }
}

/** `x-00001-of-00003.gguf` → [1, 3]. */
export function splitPart(fileName: string): [number, number] | undefined {
  const m = /-(\d{3,})-of-(\d{3,})(?:\.gguf)?$/i.exec(fileName)
  if (!m) return undefined
  const p = Number(m[1])
  const t = Number(m[2])
  if (!p || !t || p > t) return undefined
  return [p, t]
}
