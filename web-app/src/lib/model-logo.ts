// Bundled brand logos served from web-app/public. Matching is done on the model
// *family*, so a community quant (e.g. a Gemma repack by some user) still shows
// the recognizable brand mark instead of the quantizer's avatar or a letter.
// To add a brand: drop an SVG/PNG in web-app/public and append a rule. Order
// matters — more specific families first (e.g. deepseek before qwen, since
// "DeepSeek-R1-Distill-Qwen" should resolve to DeepSeek).
const FAMILY_LOGO_RULES: Array<[RegExp, string]> = [
  [/deepseek/i, '/svg/deepseek-color.svg'],
  [/gemma/i, '/svg/google-color.svg'],
  [/\bglm\b|chatglm/i, '/svg/zai.svg'],
  [/bonsai/i, '/images/model-provider/prism-ml.webp'],
  [/qwen|qwq/i, '/svg/qwen-color.svg'],
  [/(?<!o)llama/i, '/svg/meta-color.svg'],
  [/mi[sx]tral|magistral|ministral|codestral|devstral/i, '/images/model-provider/mistral.svg'],
  [/minimax/i, '/svg/minimax.svg'],
  [/lfm/i, '/svg/liquid.svg'],
  [/nemotron/i, '/images/model-provider/nvidia.svg'],
  [/gpt-oss/i, '/images/model-provider/openai.svg'],
  [/granite/i, '/svg/ibm.svg'],
  [/olmo/i, '/svg/ai2-color.svg'],
  [/hermes/i, '/svg/nousresearch.svg'],
  [/seed-oss/i, '/svg/bytedance-color.svg'],
  [/laguna/i, '/svg/poolside-color.svg'],
  [/\brnj\b/i, '/svg/essentialai-color.svg'],
  [/\bphi-?\d/i, '/svg/microsoft-color.svg'],
]

// Single-color brand marks (drawn with `fill="currentColor"`). They must be
// tinted with the current text color rather than rendered as a plain <img>,
// otherwise a black-on-transparent mark vanishes on dark backgrounds. See
// ModelLogo's CSS-mask render path.
const MONOCHROME_FAMILY_LOGOS: ReadonlySet<string> = new Set([
  '/svg/liquid.svg',
  '/svg/ibm.svg',
  '/svg/nousresearch.svg',
  '/svg/zai.svg',
  '/svg/minimax.svg',
])

// Explicit icon keys addressable from the staff-picks manifest. Curators pick
// the mark by name instead of relying on the repo id matching a family regex,
// which breaks as soon as a repo is renamed.
const ICON_KEY_LOGOS: Readonly<Record<string, string>> = {
  deepseek: '/svg/deepseek-color.svg',
  gemma: '/svg/google-color.svg',
  google: '/svg/google-color.svg',
  glm: '/svg/zai.svg',
  qwen: '/svg/qwen-color.svg',
  llama: '/svg/meta-color.svg',
  meta: '/svg/meta-color.svg',
  mistral: '/images/model-provider/mistral.svg',
  lfm: '/svg/liquid.svg',
  liquid: '/svg/liquid.svg',
  minimax: '/svg/minimax.svg',
  nvidia: '/images/model-provider/nvidia.svg',
  openai: '/images/model-provider/openai.svg',
  ibm: '/svg/ibm.svg',
  allenai: '/svg/ai2-color.svg',
  nous: '/svg/nousresearch.svg',
  bytedance: '/svg/bytedance-color.svg',
  poolside: '/svg/poolside-color.svg',
  essentialai: '/svg/essentialai-color.svg',
  microsoft: '/svg/microsoft-color.svg',
  prism: '/images/model-provider/prism-ml.webp',
  inclusionai: '/images/model-provider/inclusionai.webp',
  nanbeige: '/images/model-provider/nanbeige.webp',
  huggingface: '/images/model-provider/huggingface.svg',
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
