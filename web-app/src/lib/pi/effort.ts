import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  buildReasoningRequestFields,
  buildCloudReasoningRequestFields,
  disabledReasoningRequestFields,
  shapeCloudReasoningOverride,
  buildRemoteReasoningRequestFields,
  cloudReasoningEffortValue,
  isCloudReasoningProvider,
  modelEffortValue,
  modelReasoningEffort,
  usesTemplateReasoningKwargs,
} from '@/lib/reasoning-effort'

/** pi's synthetic OpenAI-compatible model needs the actual engine's effort scale. */
export function piEffort(provider: string, model: Model) {
  const { disableReasoning, reasoningBudget } = useGeneralSetting.getState()
  const { canDisable, levels, shownLevel } = modelReasoningEffort(
    provider,
    model,
    disableReasoning,
    reasoningBudget
  )
  const localTemplate = [
    'llamacpp',
    'llamacpp-upstream',
    'atomic-prism',
    'mlx',
  ].includes(provider)
  const fields: Record<string, Record<string, unknown>> = {}
  const map: Record<string, string | null> = Object.fromEntries(
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => [
      level,
      null,
    ])
  )
  if (canDisable || !levels.length) delete map.off
  if (canDisable && model.reasoning?.offValue)
    map.off = model.reasoning.offValue
  for (const level of levels) {
    map[level] =
      (model.reasoning?.effortKwarg === 'reasoning_effort' &&
      model.reasoning.effortValues?.length
        ? modelEffortValue(level, model.reasoning.effortValues)
        : undefined) ?? cloudReasoningEffortValue(level, provider)
    if (localTemplate)
      fields[level] = buildReasoningRequestFields(
        level,
        provider,
        model.reasoning
      )
    else if (isCloudReasoningProvider(provider)) {
      const cloudFields = buildCloudReasoningRequestFields(level, provider)
      if (cloudFields.reasoning_effort)
        cloudFields.reasoning_effort = map[level]
      fields[level] = shapeCloudReasoningOverride(
        provider,
        model.id,
        cloudFields
      )
    } else if (usesTemplateReasoningKwargs(provider))
      fields[level] = buildRemoteReasoningRequestFields(level)
  }
  if (
    canDisable &&
    (localTemplate ||
      usesTemplateReasoningKwargs(provider) ||
      (isCloudReasoningProvider(provider) && levels.length))
  ) {
    fields.off = shapeCloudReasoningOverride(
      provider,
      model.id,
      disabledReasoningRequestFields(provider, model.id, model.reasoning)
    )
  }
  return {
    level: shownLevel ?? 'off',
    map,
    fields,
    supportsThinking: levels.length > 0,
  }
}
