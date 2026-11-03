import type { CatalogModel } from '@/services/models/types'

/**
 * What a model is good for, in one line, for a row that has no curated
 * summary: Hugging Face rows, models already on disk and the tier's offer when
 * no staff pick describes it. A key under `onboarding:model.tagline`, read off
 * the repo's name and tags: what it is built for first, then its size, and
 * vision last — most recent chat models read images, so it tells rows apart
 * the least.
 */
export type ModelTagline =
  | 'code'
  | 'reasoning'
  | 'agent'
  | 'vision'
  | 'small'
  | 'sparse'
  | 'large'
  | 'general'

const PURPOSES: ReadonlyArray<[ModelTagline, RegExp]> = [
  [
    'code',
    /coder|codestral|devstral|starcoder|codegemma|(^|[^a-z])code([^a-z]|$)/,
  ],
  ['reasoning', /(^|[^a-z])r1([^a-z0-9]|$)|reason|think|qwq|distill|math/],
  ['agent', /agent|tool-use|function-calling|tool-calling/],
]

const VISION =
  /(^|[^a-z])vl([^a-z]|$)|vision|image-text-to-text|any-to-any|llava|pixtral/

/** `27B` → 27, `35B-A3B` → 35 total and 3 active, `360M` → 0.36. */
function parameters(name: string): {
  total: number | null
  active: number | null
} {
  const total = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*([bm])(?![a-z])/.exec(name)
  const active = /(?:^|[^a-z0-9])a(\d+(?:\.\d+)?)b(?![a-z])/.exec(name)
  return {
    total: total ? Number(total[1]) / (total[2] === 'm' ? 1000 : 1) : null,
    active: active ? Number(active[1]) : null,
  }
}

export function modelTagline(
  name: string,
  tags: readonly string[] = []
): ModelTagline {
  const haystack = [name, ...tags].join(' ').toLowerCase()
  for (const [tagline, clue] of PURPOSES) {
    if (clue.test(haystack)) return tagline
  }
  const { total, active } = parameters(name.toLowerCase())
  if (active !== null && total !== null && active < total) return 'sparse'
  if (total !== null && total <= 2) return 'small'
  if (total !== null && total >= 20) return 'large'
  return VISION.test(haystack) ? 'vision' : 'general'
}

/**
 * A catalog entry's Hugging Face tags. Listings and the curated catalog carry
 * them only inside the description, as `**Tags**: a, b, c`.
 */
export function catalogTags(
  model: Pick<CatalogModel, 'description'>
): string[] {
  const match = /^\*\*Tags\*\*:\s*(.*)$/m.exec(model.description ?? '')
  return match
    ? match[1]
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    : []
}

/** Hugging Face tasks a chat model is published under. */
const CHAT_TAGS = new Set([
  'conversational',
  'text-generation',
  'image-text-to-text',
  'any-to-any',
  'chat',
])

/** Anything a first chat model should not be: media, speech, embeddings. */
const NOT_CHAT =
  /text-to-image|image-to-image|text-to-video|image-to-video|video-generation|image-generation|text-to-speech|text-to-audio|speech-recognition|feature-extraction|sentence-similarity|object-detection|embedding|rerank|stable-diffusion|comfyui/

/** Builds that strip a model's safety training; never a first suggestion. */
const UNFILTERED = /uncensored|abliterat|obliterat|heretic|nsfw/

/**
 * Whether a catalog repo is a chat model fit to suggest on the first run: a
 * chat task among its tags, nothing that makes it a media, speech or
 * embedding model, and not a build with its safety training removed.
 */
export function isFirstRunChatRepo(model: CatalogModel): boolean {
  const tags = catalogTags(model)
  const haystack = [model.model_name, ...tags].join(' ').toLowerCase()
  if (NOT_CHAT.test(haystack) || UNFILTERED.test(haystack)) return false
  return tags.some((tag) => CHAT_TAGS.has(tag))
}

/**
 * A repo's name without its publisher and format suffix, so one model's
 * uploads match: `AtomicChat/Qwen3.5-9B-GGUF` and `unsloth/Qwen3.5-9B-GGUF`
 * both read `qwen3.5-9b`.
 */
export function repoKey(modelName: string): string {
  return (modelName.split('/').pop() ?? modelName)
    .toLowerCase()
    .replace(/[-_.]?(gguf|mlx.*)$/, '')
}

/**
 * The model a repo packages, so the uploads of one model by several
 * publishers count once: its `base_model:` tag, or its own name without the
 * publisher and the format suffix.
 */
export function baseModelKey(model: CatalogModel): string {
  const tags = catalogTags(model)
  const base =
    tags.find((tag) => tag.startsWith('base_model:quantized:')) ??
    tags.find(
      (tag) => tag.startsWith('base_model:') && tag.split(':').length === 2
    )
  if (base) return base.slice(base.lastIndexOf(':') + 1)
  return repoKey(model.model_name)
}
