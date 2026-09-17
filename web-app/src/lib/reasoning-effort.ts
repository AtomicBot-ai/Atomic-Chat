import type { ReasoningControls } from '@janhq/core'

import type { ReasoningBudgetLevel } from '@/hooks/useGeneralSetting'
import { isKnownProvider } from '@/stores/provider-registry-store'
import {
  isLocalProvider,
  isSelfHostedProviderName,
} from '@/utils/registerRemoteProvider'

/**
 * Maps the single UI level onto whichever reasoning knob a local model
 * actually understands. Three exist and a model has at most one of the first
 * two (see `detectReasoningControls` in core):
 *
 *  - `reasoning_effort` — a named level; the value set is model-specific and
 *    some templates raise on an unknown value, so we only ever send a value
 *    the template declared.
 *  - `thinking_budget` — a token budget the template renders into the prompt.
 *  - neither — the backend's thinking-token budget sampler, which works for
 *    any model whose template has thinking tags.
 */

export type ReasoningEffortLevel = Exclude<ReasoningBudgetLevel, 'off'>

/**
 * Thinking-token budget per level, used by both budget knobs. `max` is absent
 * on purpose: it means "no cap".
 */
export const REASONING_LEVEL_TOKENS: Record<
  Exclude<ReasoningEffortLevel, 'max'>,
  number
> = {
  low: 256,
  medium: 1024,
  high: 4096,
  xhigh: 8192,
}

/**
 * One scale for UI levels and template values, so the two are comparable.
 * `minimal` is only ever a model value — the picker does not offer it.
 */
const EFFORT_RANK: Record<string, number> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * The full scale, used by a model whose thinking phase is driven by a token
 * budget rather than a template-declared effort value.
 */
export const ALL_LEVELS: ReasoningEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * Providers whose own API carries a reasoning switch, dispatched by name in
 * `custom-chat-transport`. Named rather than derived from the registry because
 * these are also the APIs that reject an unrecognised request field outright,
 * so they must be excluded even in the moment before the registry resolves.
 */
const NATIVE_REASONING_API_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'xai',
  'google',
  'gemini',
  'moonshot',
])

/**
 * Whether a provider's thinking phase is driven by chat-template kwargs.
 *
 * True for the servers the *user* runs: a self-hosted `llama-server` or Ollama,
 * and any OpenAI-compatible endpoint they added themselves. Those serve
 * open-weight models, so thinking is switched by the same
 * `chat_template_kwargs` the local engines use — but their models arrive
 * without the `ReasoningControls` the local backends read off the chat
 * template, so nothing here can be derived from the model itself.
 *
 * False for the local engines, which have real controls and go through
 * {@link buildReasoningRequestFields}, and for catalogue cloud providers,
 * which drive reasoning through their own API fields (or not at all) and would
 * only be offered a control that does nothing.
 */
export const usesTemplateReasoningKwargs = (
  provider: string | undefined
): boolean => {
  if (!provider) return false
  if (isLocalProvider(provider)) return false
  if (NATIVE_REASONING_API_PROVIDERS.has(provider)) return false
  if (isSelfHostedProviderName(provider)) return true
  // Anything the catalogue does not define is one the user added by hand.
  return !isKnownProvider(provider)
}

const usesNativeEffort = (
  controls?: ReasoningControls
): controls is ReasoningControls & { effortValues: string[] } =>
  controls?.effortKwarg === 'reasoning_effort' &&
  Array.isArray(controls.effortValues) &&
  controls.effortValues.length > 0

/** Some native APIs expose effort levels but no way to disable reasoning. */
export const canDisableReasoning = (
  provider: string | undefined,
  controls?: ReasoningControls
): boolean => {
  if (controls?.canDisable !== undefined) return controls.canDisable
  return provider !== 'chatgpt' || Boolean(controls?.offValue)
}

/**
 * Levels the model can express: everything for a budget model, and only the
 * declared values for a native-effort one.
 */
export const availableReasoningLevels = (
  controls?: ReasoningControls
): ReasoningEffortLevel[] => {
  if (!controls?.supportsThinking) return []
  if (!usesNativeEffort(controls)) return ALL_LEVELS

  const declared = new Set(
    controls.effortValues.map((value) => EFFORT_RANK[value])
  )
  const levels = ALL_LEVELS.filter((level) => declared.has(EFFORT_RANK[level]))
  return levels.length ? levels : ['low', 'medium', 'high']
}

/** Clamp a stored level onto what this model offers. */
export const resolveReasoningLevel = (
  level: ReasoningEffortLevel,
  available: ReasoningEffortLevel[]
): ReasoningEffortLevel | undefined => {
  if (!available.length) return undefined
  if (available.includes(level)) return level

  const target = EFFORT_RANK[level]
  return available.reduce((closest, candidate) => {
    const closestGap = Math.abs(EFFORT_RANK[closest] - target)
    const candidateGap = Math.abs(EFFORT_RANK[candidate] - target)
    // Ties go to the weaker level, which is the safer surprise.
    return candidateGap < closestGap ? candidate : closest
  })
}

/**
 * The `reasoning_effort` string to send for a level, chosen from the values the
 * template declared. Never invents a value.
 */
export const modelEffortValue = (
  level: ReasoningEffortLevel,
  effortValues: string[]
): string | undefined => {
  const target = EFFORT_RANK[level]
  const ranked = effortValues
    .map((value) => ({ value, rank: EFFORT_RANK[value] }))
    .filter(
      (entry): entry is { value: string; rank: number } =>
        entry.rank !== undefined
    )

  if (!ranked.length) return undefined

  return ranked.reduce((closest, candidate) =>
    Math.abs(candidate.rank - target) < Math.abs(closest.rank - target)
      ? candidate
      : closest
  ).value
}

/**
 * Request fields that put a level into effect for a local provider.
 * Returns an empty object when the model has no thinking phase to control.
 */
export const buildReasoningRequestFields = (
  level: ReasoningEffortLevel,
  provider: string,
  controls?: ReasoningControls
): Record<string, unknown> => {
  if (!controls?.supportsThinking) return {}

  if (usesNativeEffort(controls)) {
    const value = modelEffortValue(level, controls.effortValues)
    if (!value) return {}
    // mlx-vlm and native reasoning APIs read a top-level
    // `reasoning_effort`; llama.cpp only forwards template kwargs.
    return provider === 'mlx' || provider === 'chatgpt' || provider === 'openai'
      ? { reasoning_effort: value }
      : { chat_template_kwargs: { reasoning_effort: value } }
  }

  if (level === 'max') return {}

  const tokens = REASONING_LEVEL_TOKENS[level]

  if (controls.effortKwarg === 'thinking_budget') {
    // Seed-OSS-style templates render the budget into the prompt themselves.
    return provider === 'mlx'
      ? { thinking_budget: tokens }
      : { chat_template_kwargs: { thinking_budget: tokens } }
  }

  // Generic path: the backend's budget sampler closes the thinking block.
  return provider === 'mlx'
    ? { thinking_budget: tokens }
    : { reasoning_budget_tokens: tokens }
}

/**
 * The template-native effort value to send to a server we cannot inspect.
 * `reasoning_effort` templates in the wild (gpt-oss and its ports) declare
 * `low | medium | high` and nothing else, so the two levels above `high` land
 * on `high` rather than on a value that would raise inside the template.
 */
const REMOTE_EFFORT_VALUE: Record<ReasoningEffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/**
 * Request fields that put a level into effect on a remote provider whose
 * models arrive without `ReasoningControls` — see
 * {@link usesTemplateReasoningKwargs}.
 *
 * Nothing about the model is known here, so this sends the two kwargs an
 * open-weight chat template might read and lets the template pick: a Qwen-style
 * one honours `enable_thinking`, a gpt-oss-style one honours
 * `reasoning_effort`, and one that declares neither ignores both. Jinja drops
 * kwargs it never references, and servers that do not implement
 * `chat_template_kwargs` at all ignore the field — the same assumption the
 * "off" path has always made when switching thinking off for these providers.
 */
export const buildRemoteReasoningRequestFields = (
  level: ReasoningEffortLevel
): Record<string, unknown> => ({
  chat_template_kwargs: {
    enable_thinking: true,
    reasoning_effort: REMOTE_EFFORT_VALUE[level],
  },
})

/**
 * Reasoning intent for one Agent turn, resolved on this side so the Rust
 * backend never has to parse a chat template. Mirrored by
 * `AgentReasoningRequest` in `src-tauri/src/core/agent/types.rs`.
 */
export type AgentReasoningRequest = {
  /** `false` means: actively suppress the thinking phase for this turn. */
  enabled: boolean
  /** Resolved level, clamped to what this model declares. Absent when off. */
  effort?: ReasoningEffortLevel
  /**
   * Thinking-token budget for the backend's budget sampler. Absent means no
   * cap — either `max`, or a model driven by a native effort value instead.
   */
  budget_tokens?: number
  /** Template-native effort value. Only ever one the template declared. */
  effort_value?: string
  /** Whether the model's chat template declares a thinking phase at all. */
  supports_thinking: boolean
}

/**
 * The reasoning intent to send with an Agent turn.
 *
 * Unlike the chat transport, which dispatches per provider at request time, the
 * Agent backend gets one resolved decision and picks the wire shape its
 * transport understands. A model with no thinking phase is always `enabled:
 * false` — there is nothing to control, and the llama.cpp grammar must stay
 * array-only for it.
 */
export const buildAgentReasoningRequest = (
  level: ReasoningBudgetLevel,
  disableReasoning: boolean,
  controls?: ReasoningControls,
  allowDisable = true
): AgentReasoningRequest => {
  const supportsThinking = controls?.supportsThinking === true
  const off: AgentReasoningRequest = {
    enabled: false,
    supports_thinking: supportsThinking,
  }
  if (!supportsThinking) return off
  if (allowDisable && (disableReasoning || level === 'off')) return off

  const available = availableReasoningLevels(controls)
  const requestedLevel =
    !allowDisable && (disableReasoning || level === 'off')
      ? (available[0] ?? 'low')
      : level === 'off'
        ? 'low'
        : level
  const resolved = resolveReasoningLevel(
    requestedLevel,
    available
  )
  if (!resolved) return off

  const request: AgentReasoningRequest = {
    enabled: true,
    effort: resolved,
    supports_thinking: true,
  }
  if (usesNativeEffort(controls)) {
    const value = modelEffortValue(resolved, controls.effortValues)
    if (value) request.effort_value = value
    return request
  }
  // `max` is "no cap", so it deliberately carries no budget.
  if (resolved !== 'max') {
    request.budget_tokens = REASONING_LEVEL_TOKENS[resolved]
  }
  return request
}
