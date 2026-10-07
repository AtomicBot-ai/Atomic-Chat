import type { DiffusionFamilyId } from '@/services/diffusion/types'

// Bundled brand logos served from web-app/public. Matching is done on the model
// *family*, so a community quant (e.g. a Gemma repack by some user) still shows
// the recognizable brand mark instead of the quantizer's avatar or a letter.
// To add a brand: drop an SVG/PNG in web-app/public and append a rule. Order
// matters — more specific families first (e.g. deepseek before qwen, since
// "DeepSeek-R1-Distill-Qwen" should resolve to DeepSeek).
const FAMILY_LOGO_RULES: Array<[RegExp, string]> = [
  [/deepseek/i, '/svg/deepseek-color.svg'],
  // EmbeddingGemma carries the Gemma mark itself, not Google's "G".
  [/embeddinggemma/i, '/svg/gemma-color.svg'],
  [/gemma/i, '/svg/google-color.svg'],
  [/\bglm\b|chatglm/i, '/svg/zai.svg'],
  [/bonsai/i, '/images/model-provider/prism-ml.webp'],
  [/ornith/i, '/images/model-provider/ornith.webp'],
  [/\bling\b/i, '/images/model-provider/ling.webp'],
  [/qwen|qwq/i, '/svg/qwen-color.svg'],
  [/(?<!o)llama/i, '/svg/meta-color.svg'],
  [/\bmuse-(spark|glimmer|image)/i, '/svg/meta-color.svg'],
  [
    /mi[sx]tral|magistral|ministral|codestral|devstral|voxtral/i,
    '/images/model-provider/mistral.svg',
  ],
  [/minimax/i, '/svg/minimax.svg'],
  [/lfm/i, '/svg/liquid.svg'],
  [/nemotron/i, '/images/model-provider/nvidia.svg'],
  [/gpt-oss/i, '/svg/openai-mark.svg'],
  [/granite/i, '/svg/ibm.svg'],
  // Embedding models: BAAI's bge family and Nomic's embed models.
  [/\bbge\b|bge-/i, '/svg/baai.svg'],
  [/nomic/i, '/images/model-provider/nomic.svg'],
  [/olmo/i, '/svg/ai2-color.svg'],
  [/hermes/i, '/svg/nousresearch.svg'],
  [/seed-oss/i, '/svg/bytedance-color.svg'],
  [/laguna/i, '/svg/poolside-color.svg'],
  [/\brnj\b/i, '/svg/essentialai-color.svg'],
  [/\bphi-?\d/i, '/svg/microsoft-color.svg'],
  // Image and video checkpoints. Z-Image is from Tongyi-MAI, not the Qwen
  // model family, so it has its own mark rather than inheriting Qwen.
  [/\bz[- ]?image/i, '/svg/z-image.svg'],
  [/\bflux[.-]?\d/i, '/svg/bfl.svg'],
  // Krea has no mark of its own here; Krea 2 is drawn like FLUX.1 Krea, as its
  // family id's icon key (`bfl`) already has it.
  [/\bkrea[- ]?2\b/i, '/svg/bfl.svg'],
  // `Wan2.2-TI2V-5B` on the Hub, `Wan 2.2 TI2V 5B` in the catalog.
  [/\bwan[- ]?\d/i, '/svg/qwen-color.svg'],
  [/\bltx-?(video|\d)/i, '/svg/lightricks.svg'],
]

// Single-color brand marks (drawn with `fill="currentColor"`, or a raster
// mark in one dark color on transparency like PrismML's). They must be
// tinted with the current text color rather than rendered as a plain <img>,
// otherwise a black-on-transparent mark vanishes on dark backgrounds. See
// ModelLogo's CSS-mask render path.
const MONOCHROME_FAMILY_LOGOS: ReadonlySet<string> = new Set([
  '/images/model-provider/prism-ml.webp',
  '/svg/liquid.svg',
  '/svg/ibm.svg',
  '/svg/baai.svg',
  '/svg/nousresearch.svg',
  '/svg/zai.svg',
  '/svg/minimax.svg',
  '/svg/bfl.svg',
  '/svg/lightricks.svg',
  '/svg/openai-mark.svg',
  '/svg/z-image.svg',
])

// Explicit icon keys addressable from the staff-picks manifest. Curators pick
// the mark by name instead of relying on the repo id matching a family regex,
// which breaks as soon as a repo is renamed.
const ICON_KEY_LOGOS: Readonly<Record<string, string>> = {
  'deepseek': '/svg/deepseek-color.svg',
  'gemma': '/svg/google-color.svg',
  'gemma-mark': '/svg/gemma-color.svg',
  'google': '/svg/google-color.svg',
  'glm': '/svg/zai.svg',
  'qwen': '/svg/qwen-color.svg',
  'llama': '/svg/meta-color.svg',
  'meta': '/svg/meta-color.svg',
  'muse': '/svg/meta-color.svg',
  'mistral': '/images/model-provider/mistral.svg',
  'lfm': '/svg/liquid.svg',
  'liquid': '/svg/liquid.svg',
  'minimax': '/svg/minimax.svg',
  'nvidia': '/images/model-provider/nvidia.svg',
  'openai': '/svg/openai-mark.svg',
  'ibm': '/svg/ibm.svg',
  // BAAI (bge) from @lobehub/icons-static-svg 1.95.1; Nomic's own favicon mark,
  // a black N on its white square, which reads on either theme as it is.
  'baai': '/svg/baai.svg',
  'nomic': '/images/model-provider/nomic.svg',
  'allenai': '/svg/ai2-color.svg',
  'nous': '/svg/nousresearch.svg',
  'bytedance': '/svg/bytedance-color.svg',
  'poolside': '/svg/poolside-color.svg',
  'essentialai': '/svg/essentialai-color.svg',
  'microsoft': '/svg/microsoft-color.svg',
  'prism': '/images/model-provider/prism-ml.webp',
  'ling': '/images/model-provider/ling.webp',
  'inclusionai': '/images/model-provider/inclusionai.webp',
  'nanbeige': '/images/model-provider/nanbeige.webp',
  'ornith': '/images/model-provider/ornith.webp',
  'convai': '/images/model-provider/convai.webp',
  // Decision model makers (atomic-chat-conf models/decision.json `icon`).
  'supersonic': '/images/model-provider/supersonic.webp',
  'interfaze': '/images/model-provider/interfaze.webp',
  'bespoke': '/images/model-provider/bespoke.webp',
  'cloudflare': '/images/model-provider/cloudflare.webp',
  'openjev': '/images/model-provider/openjev.webp',
  'bfl': '/svg/bfl.svg',
  'flux': '/svg/bfl.svg',
  'tongyi': '/svg/qwen-color.svg',
  'wan': '/svg/qwen-color.svg',
  'lightricks': '/svg/lightricks.svg',
  'ltx': '/svg/lightricks.svg',
  'z-image': '/svg/z-image.svg',
  'huggingface': '/images/model-provider/huggingface.svg',
}

// Icon key per image/video family id. The catalog is remote and its display
// names can change without a release; the ids are the stable contract, and a
// `Record` over the id union makes a new family fail to compile without a mark.
export const DIFFUSION_FAMILY_ICON_KEYS: Readonly<
  Record<DiffusionFamilyId, string>
> = {
  'z-image': 'z-image',
  'flux.2-klein': 'bfl',
  'flux.1': 'bfl',
  'flux.1-uncensored': 'bfl',
  'flux.1-abliterated': 'bfl',
  'flux.1-nsfw-realism': 'bfl',
  'flux.1-krea': 'bfl',
  'krea-2-turbo': 'bfl',
  'qwen-image': 'qwen',
  'qwen-image-2.1': 'qwen',
  'wan2.2-ti2v-5b': 'wan',
  'ltx-2': 'ltx',
}

/**
 * The mark of a decision checkpoint without an `icon`: every checkpoint in the
 * catalog is a Convai laya one, and catalogs from before the field carry none.
 */
export const DECISION_ICON_KEY = 'convai'

/**
 * The logo key of a decision model: its catalog `icon`, else Convai's for a
 * laya checkpoint, else none (the logo falls back to the model family, then
 * to a letter).
 */
export function decisionIconKey(model: {
  icon?: string
  format: 'checkpoint' | 'gguf'
}): string | undefined {
  return (
    model.icon ??
    (model.format === 'checkpoint' ? DECISION_ICON_KEY : undefined)
  )
}

/**
 * The logo key of an embedding model: its catalog `icon`, which every entry
 * carries (atomic-chat-conf models/embedding.json).
 */
export function embeddingIconKey(model: { icon: string }): string {
  return model.icon
}

/** The Hugging Face mark, used as the neutral avatar for long-tail results. */
export const HUGGINGFACE_LOGO_SRC = ICON_KEY_LOGOS.huggingface

export function modelFamilyLogoSrc(modelName?: string): string | null {
  if (!modelName) return null
  for (const [pattern, src] of FAMILY_LOGO_RULES) {
    if (pattern.test(modelName)) return src
  }
  return null
}

/** Resolve a manifest `icon` key. Unknown keys fall through to the caller. */
export function iconKeyLogoSrc(iconKey?: string): string | null {
  if (!iconKey) return null
  return ICON_KEY_LOGOS[iconKey.toLowerCase()] ?? null
}

export function isMonochromeFamilyLogo(src: string): boolean {
  return MONOCHROME_FAMILY_LOGOS.has(src)
}
