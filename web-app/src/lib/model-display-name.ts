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

/** Quantization markers: q4_k_m, iq3_xxs, f16, bf16, 4bit, mxfp4, i1… */
const QUANT_BODY =
  '(?:i?q\\d+(?:_[a-z0-9]+)*|f16|fp16|bf16|f32|fp32|int4|int8|\\d+bits?|mxfp\\d|i1)'

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

  // "…-Instruct-it" and the like would otherwise read twice.
  const deduped = tokens.filter((token, i) => token !== tokens[i - 1])

  const pretty = deduped.join(' ').trim()
  return pretty || withoutExt || name
}
