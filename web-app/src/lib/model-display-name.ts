// Human-readable model names for onboarding.
//
// Repo ids and GGUF file names are packaging artefacts: they carry the author,
// the file format and the quantization ("unsloth/Llama-3.2-3B-Instruct-GGUF",
// "gemma-4-e4b-it-4bit"). None of that means anything to someone who has never
// downloaded a local model, so the picker shows the model, not the file:
// "Llama 3.2 3B Instruct", "Gemma 4 E4B Instruct". Size is rendered separately
// next to the name, so dropping the quant here loses nothing on screen.

/** Packaging/format markers — never part of a model's name. */
const FORMAT_TOKENS = new Set([
  'gguf',
  'ggml',
  'mlx',
  'safetensors',
  'onnx',
  'awq',
  'gptq',
  'imatrix',
  'hf',
])

/** Quantization markers: q4_k_m, iq3_xxs, pq2_0 (PrismML), f16, bf16, 4bit,
 *  mxfp4, i1… */
const QUANT_BODY =
  '(?:[ip]?q\\d+(?:_[a-z0-9]+)*|f16|fp16|bf16|f32|fp32|int4|int8|\\d+bits?|mxfp\\d|i1)'

/** A quant is a whole segment, and its own underscores belong to it: splitting
 *  on separators first would leave a stray "K M" behind from "Q4_K_M". */
const QUANT_SEGMENT = new RegExp(`[-_](?:${QUANT_BODY})(?=[-_.]|$)`, 'gi')

const QUANT_TOKEN = new RegExp(`^${QUANT_BODY}$`, 'i')

/** Canonical casing for model families. */
const FAMILY_CASING: Record<string, string> = {
  bonsai: 'Bonsai',
  codestral: 'Codestral',
  deepseek: 'DeepSeek',
  devstral: 'Devstral',
  exaone: 'EXAONE',
  falcon: 'Falcon',
  gemma: 'Gemma',
  glm: 'GLM',
  granite: 'Granite',
  hermes: 'Hermes',
  internlm: 'InternLM',
  lfm: 'LFM',
  ling: 'Ling',
  llama: 'Llama',
  magistral: 'Magistral',
  minimax: 'MiniMax',
  ministral: 'Ministral',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  nemotron: 'Nemotron',
  olmo: 'OLMo',
  phi: 'Phi',
  qwen: 'Qwen',
  qwq: 'QwQ',
  smollm: 'SmolLM',
  tinyllama: 'TinyLlama',
  yi: 'Yi',
}

/** Families whose versions are written with a dot ("qwen35" → "Qwen3.5"). */
const DOTTED_VERSION_FAMILIES = new Set(['qwen', 'glm'])

/**
 * Instruction-tuned is the norm for everything onboarding offers, so the
 * "Instruct"/"it" suffix distinguishes nothing and only makes the name longer.
 */
const TUNING_TOKENS = new Set(['instruct', 'it'])

/** Suffixes that read as words rather than as identifiers. */
const WORD_CASING: Record<string, string> = {
  abliterated: 'Abliterated',
  base: 'Base',
  chat: 'Chat',
  code: 'Code',
  coder: 'Coder',
  distill: 'Distill',
  large: 'Large',
  lite: 'Lite',
  math: 'Math',
  medium: 'Medium',
  micro: 'Micro',
  mini: 'Mini',
  moe: 'MoE',
  nano: 'Nano',
  omni: 'Omni',
  preview: 'Preview',
  pro: 'Pro',
  //* Quantization-aware training — an acronym, and now part of a shipped
  //* recommendation's name (`unsloth/gemma-4-12B-it-qat-GGUF`), so "Qat" shows.
  qat: 'QAT',
  reasoning: 'Reasoning',
  small: 'Small',
  thinking: 'Thinking',
  turbo: 'Turbo',
  uncensored: 'Uncensored',
  vision: 'Vision',
  vl: 'VL',
  vlm: 'VLM',
}

/** Parameter counts and MoE active-parameter markers: 4b, 450m, a3b, e4b. */
const SIZE_TOKEN = /^[ae]?\d+(?:\.\d+)?[bm]$/i

function formatToken(raw: string): string {
  const lower = raw.toLowerCase()

  if (WORD_CASING[lower]) return WORD_CASING[lower]
  if (SIZE_TOKEN.test(lower)) return lower.toUpperCase()
  if (FAMILY_CASING[lower]) return FAMILY_CASING[lower]

  // Family glued to its version: "qwen3", "qwen35", "gemma4".
  const glued = lower.match(/^([a-z]+)(\d[\d.]*)$/)
  if (glued && FAMILY_CASING[glued[1]]) {
    const family = FAMILY_CASING[glued[1]]
    let version = glued[2]
    // "qwen35" is Qwen3.5, not Qwen thirty-five.
    if (DOTTED_VERSION_FAMILIES.has(glued[1]) && /^\d\d$/.test(version)) {
      version = `${version[0]}.${version[1]}`
    }
    return `${family}${version}`
  }

  // Anything already carrying capitals is a deliberate spelling ("LFM2.5",
  // "E2B", "R1") — leave it alone. Plain lowercase words get a capital.
  if (raw !== lower) return raw
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * Turn a repo id or model file name into something a first-time user can read.
 * Falls back to the input (minus the author) whenever the cleanup would leave
 * nothing behind, so an unrecognized naming scheme is never rendered as blank.
 */
export function prettyModelName(name?: string): string {
  if (!name) return ''

  const withoutAuthor = name.split('/').pop() ?? name
  const withoutExt = withoutAuthor
    .replace(/\.(gguf|safetensors|bin|mlx)$/i, '')
    .replace(QUANT_SEGMENT, '')
    // Sanitized local ids turn decimal versions into underscores (`1_5`).
    // Restore that punctuation before tokenizing the rest of the slug.
    .replace(/(\d)_(\d)/g, '$1.$2')

  const tokens = withoutExt
    .split(/[-_\s]+/)
    .filter(Boolean)
    .filter((token) => {
      const lower = token.toLowerCase()
      return (
        !FORMAT_TOKENS.has(lower) &&
        !TUNING_TOKENS.has(lower) &&
        !QUANT_TOKEN.test(lower)
      )
    })
    .map(formatToken)

  const pretty = dropRepeats(tokens).join(' ').trim()
  return pretty || withoutExt || name
}

/**
 * Drop what reads twice. A word repeated in place ("…-Instruct-it") goes, and
 * so does a run of two or more words already read: some ids glue the repo
 * name to its file name ("Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS"), which would
 * otherwise read "Qwen3.5 9B Qwen3.5 9B".
 */
function dropRepeats(tokens: string[]): string[] {
  const kept: string[] = []
  let i = 0
  while (i < tokens.length) {
    const read = ` ${kept.join(' ').toLowerCase()} `
    let repeated = 0
    for (let length = tokens.length - i; length >= 2; length--) {
      const run = tokens
        .slice(i, i + length)
        .join(' ')
        .toLowerCase()
      if (read.includes(` ${run} `)) {
        repeated = length
        break
      }
    }
    if (repeated > 0) {
      i += repeated
      continue
    }
    if (tokens[i] !== kept.at(-1)) kept.push(tokens[i])
    i += 1
  }
  return kept
}

/**
 * The quantization of a model file id ("IQ4_XS", "Q4_K_M", "PQ2_0"), spelled
 * as the file spells it, or undefined when the id names none. With several
 * markers ("…_i1-IQ4_XS") the last one is the quant.
 */
function modelQuantLabel(id?: string): string | undefined {
  if (!id) return undefined
  const file = (id.replace(/\\/g, '/').split('/').pop() ?? id).replace(
    /\.(gguf|safetensors|bin|mlx)$/i,
    ''
  )
  const markers = file.match(QUANT_SEGMENT)
  return markers?.at(-1)?.slice(1)
}

/**
 * Compact label for the composer and its model picker. A user nickname wins;
 * otherwise strip the repository owner, file format and quantization. The
 * full technical id remains available in the element's title attribute.
 */
export function compactModelDisplayName(model: Model): string {
  const custom = model.displayName?.trim()
  return custom || prettyModelName(model.id) || model.id
}

/**
 * Readable model name with its repository owner and quantization. The compact
 * composer pill deliberately omits both, while the model details and full
 * picker need them to tell apart otherwise identical rows: the same model from
 * different authors, or two quants of one repo. A user nickname is shown as
 * given, after the owner. A namespace segment is shown once, even when the id
 * repeats it ("prism-ml/prism-ml/…") or the nickname already starts with it.
 */
export function qualifiedModelDisplayName(model: Model): string {
  const compact = compactModelDisplayName(model)
  const quant = model.displayName?.trim()
    ? undefined
    : modelQuantLabel(model.id)
  const name =
    quant && !compact.toLowerCase().includes(quant.toLowerCase())
      ? `${compact} ${quant}`
      : compact
  const normalizedId = model.id.replace(/\\/g, '/')
  const separator = normalizedId.lastIndexOf('/')
  if (separator <= 0) return name
  const namespace = normalizedId
    .slice(0, separator)
    .split('/')
    .filter(
      (segment, i, segments) =>
        segment.toLowerCase() !== segments[i - 1]?.toLowerCase()
    )
  if (name.toLowerCase().startsWith(`${namespace.at(-1)?.toLowerCase()}/`)) {
    namespace.pop()
  }
  return [...namespace, name].join('/')
}
