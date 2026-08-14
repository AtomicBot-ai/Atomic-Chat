/**
 * Detection of a model's reasoning ("thinking") controls from its chat template.
 *
 * Neither llama.cpp nor mlx-vlm reports thinking support over HTTP: `/props`
 * returns the raw Jinja template and `chat_template_caps`, which covers tools
 * and roles but not reasoning. The only signal available before the first
 * request is the template text itself.
 *
 * Three distinct knobs exist, and a model has at most one of the first two:
 *  - `reasoning_effort` — a named level baked into the prompt. Rare: only a
 *    handful of families, each with its own value set. Some templates raise on
 *    an unknown value, so a level must never be guessed.
 *  - `thinking_budget` — a token budget the template renders into the prompt.
 *  - neither — thinking is on/off only, and the caller falls back to the
 *    backend's generic thinking-token budget sampler.
 */

export type ReasoningEffortKwarg = 'reasoning_effort' | 'thinking_budget'

export type ReasoningControls = {
  /** Template exposes a thinking phase in any form. */
  supportsThinking: boolean
  /** Template-native effort knob, when the model has one. */
  effortKwarg?: ReasoningEffortKwarg
  /** Legal `reasoning_effort` values, weakest first, off-like values removed. */
  effortValues?: string[]
  /** `reasoning_effort` value that disables thinking, for templates that have one. */
  offValue?: string
}

const THINKING_KWARG_VARS = [
  'enable_thinking',
  'reasoning_effort',
  'thinking_budget',
]

const JINJA_THINKING_CONDITIONALS: RegExp[] = [
  /\{%-?\s*if\s+\(?\s*\w*enable[\s_]+\w*(thinking|think|reasoning)/i,
  /\{%-?\s*if\s+\w*(thinking|reasoning)\s*(is not|==|!=)/i,
  /\{%-?\s*if\s+not\s+\w*enable/i,
  /\{%-?\s*if\s+ns\.enable_thinking/i,
]

/** Paired thinking-content tags. The self-closing entry is Kimi-K2 / Gemma 4. */
const THINKING_TAG_PATTERNS: Array<[string, string | null]> = [
  ['<think>', '</think>'],
  ['<|channel>thought', '<|channel|>'],
  ['<|think|>', '</|think|>'],
  ['<seed:think|>', '</seed:think|>'],
  ['<|START_THINKING|>', '<|END_THINKING|>'],
  ['<think></think>', null],
]

/** Values that mean "do not think" rather than an effort level. */
const OFF_LIKE_EFFORTS = new Set(['none', 'no_think', 'nothink', 'off', 'disabled'])

/** Canonical weakest-to-strongest ordering; unknown values keep template order. */
const EFFORT_RANK: Record<string, number> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

const DEFAULT_EFFORT_VALUES = ['low', 'medium', 'high']

const referencesKwarg = (template: string, kwarg: string): boolean => {
  const regex = new RegExp(
    `(\\{\\{[^{}]*\\b${kwarg}\\b[^{}]*\\}\\}|\\{%[^{}]*\\b${kwarg}\\b[^{}]*%\\})`,
    'i'
  )
  return regex.test(template)
}

const hasThinkingTags = (template: string): boolean =>
  THINKING_TAG_PATTERNS.some(
    ([start, end]) => template.includes(start) && (!end || template.includes(end))
  )

/**
 * Pull the authoritative value set out of a validation guard, e.g.
 * `{%- elif reasoning_effort not in ['high', 'low', 'no_think'] %}` (Hunyuan 3)
 * or out of the enumeration in an error message, e.g.
 * `expected none/minimal/low/medium/high/xhigh/max or a number` (Inkling).
 *
 * A plain `reasoning_effort in [...]` is deliberately ignored: templates use it
 * to special-case a subset (Solar checks `["low", "minimal"]` while also
 * accepting `high`), so it does not describe the legal set.
 */
const extractDeclaredEfforts = (template: string): string[] | undefined => {
  const guard = template.match(
    /reasoning_effort[^%}]*?\bnot\s+in\s*[[(]([^\])]*)[\])]/i
  )
  if (guard) {
    const values = [...guard[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) =>
      m[1].trim().toLowerCase()
    )
    if (values.length) return values
  }

  const expected = template.match(
    /reasoning_effort[\s\S]{0,120}?expected\s+([a-z_]+(?:\/[a-z_]+)+)/i
  )
  if (expected) {
    return expected[1].split('/').map((value) => value.trim().toLowerCase())
  }

  return undefined
}

const sortByEffort = (values: string[]): string[] =>
  [...values].sort((a, b) => {
    const rankA = EFFORT_RANK[a]
    const rankB = EFFORT_RANK[b]
    if (rankA === undefined && rankB === undefined) return 0
    if (rankA === undefined) return 1
    if (rankB === undefined) return -1
    return rankA - rankB
  })

/**
 * Inspect a chat template and report which reasoning controls it accepts.
 *
 * @param chatTemplate Raw Jinja chat template, e.g. GGUF `tokenizer.chat_template`.
 */
export const detectReasoningControls = (
  chatTemplate?: string
): ReasoningControls => {
  if (!chatTemplate) return { supportsThinking: false }

  const supportsThinking =
    THINKING_KWARG_VARS.some((kwarg) => referencesKwarg(chatTemplate, kwarg)) ||
    JINJA_THINKING_CONDITIONALS.some((pattern) => pattern.test(chatTemplate)) ||
    hasThinkingTags(chatTemplate)

  if (!supportsThinking) return { supportsThinking: false }

  if (referencesKwarg(chatTemplate, 'reasoning_effort')) {
    const declared = extractDeclaredEfforts(chatTemplate)
    const offValue = declared?.find((value) => OFF_LIKE_EFFORTS.has(value))
    const levels = sortByEffort(
      (declared ?? DEFAULT_EFFORT_VALUES).filter(
        (value) => !OFF_LIKE_EFFORTS.has(value)
      )
    )
    return {
      supportsThinking: true,
      effortKwarg: 'reasoning_effort',
      effortValues: levels.length ? levels : DEFAULT_EFFORT_VALUES,
      ...(offValue ? { offValue } : {}),
    }
  }

  if (referencesKwarg(chatTemplate, 'thinking_budget')) {
    return { supportsThinking: true, effortKwarg: 'thinking_budget' }
  }

  return { supportsThinking: true }
}
