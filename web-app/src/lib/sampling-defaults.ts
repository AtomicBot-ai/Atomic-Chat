import { defaultAssistant } from '@/hooks/useAssistant'
import { paramGroups } from '@/lib/predefinedParams'

/**
 * "Reset to default" for sampling: the knobs the Run settings panel exposes go
 * back to what a new assistant starts with — `defaultAssistant.parameters`,
 * the same bag `AddEditAssistant` seeds — so a user who dragged the sliders
 * into a state that no longer answers well is one click from one that does.
 */

/** The sampling knobs the Run settings panel exposes, in its order. */
export const RUN_SETTINGS_SAMPLING_KEYS: string[] = [
  ...paramGroups.sampling,
  ...paramGroups.penalties,
]

const isSamplingKey = (key: string) => RUN_SETTINGS_SAMPLING_KEYS.includes(key)

/**
 * `parameters` with every panel knob back on its default.
 *
 * Knobs the default leaves unset (Min P, the two OpenAI-style penalties) are
 * removed rather than pinned: the bag is sent verbatim in the request, so an
 * absent key means the engine's own default. Keys the panel does not show —
 * `stream`, anything written into `assistant.json` by hand — are kept.
 */
export function withDefaultSampling(
  parameters: Record<string, unknown> = {}
): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(parameters).filter(([key]) => !isSamplingKey(key))
  )
  const defaults = Object.fromEntries(
    Object.entries(defaultAssistant.parameters ?? {}).filter(([key]) =>
      isSamplingKey(key)
    )
  )
  return { ...kept, ...defaults }
}

/**
 * Whether there is anything to reset: a knob off its default, or the "user
 * tuned this" flag on its own — it also keeps a model family's recommended
 * sampler from applying (see `withRecommendedSampling`), so it is part of the
 * state a reset has to undo.
 */
export function hasCustomSampling(assistant: Assistant): boolean {
  if (assistant.sampling_overridden === true) return true
  const defaults: Record<string, unknown> = defaultAssistant.parameters ?? {}
  const parameters: Record<string, unknown> = assistant.parameters ?? {}
  return RUN_SETTINGS_SAMPLING_KEYS.some(
    (key) => parameters[key] !== defaults[key]
  )
}
