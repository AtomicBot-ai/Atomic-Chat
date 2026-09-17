import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ALL_LEVELS,
  availableReasoningLevels,
  canDisableReasoning,
  resolveReasoningLevel,
  usesTemplateReasoningKwargs,
  type ReasoningEffortLevel,
} from '@/lib/reasoning-effort'

/**
 * The reasoning effort as the composer shows it: the scale the selected model
 * can express and the level the stored preference lands on within it.
 *
 * Shared by the model pill (which carries the level as its subtitle) and the
 * effort slider inside the pill's panel, so the two agree on when there is a
 * level to show at all.
 */
export const useReasoningEffort = () => {
  const { t } = useTranslation()
  const disableReasoning = useGeneralSetting((state) => state.disableReasoning)
  const reasoningBudget = useGeneralSetting((state) => state.reasoningBudget)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)

  const canDisable = canDisableReasoning(
    selectedProvider,
    selectedModel?.reasoning
  )
  const enabled = !disableReasoning || !canDisable

  // No model picked yet, or one without a thinking phase: no scale, so no
  // level on the pill. The stored preference is kept for the next pick.
  //
  // A model on a self-hosted or user-added OpenAI-compatible provider reaches
  // us without `reasoning` — those controls are read off the chat template by
  // the local backends, and there is no template to read here. Its thinking
  // phase is still driven by chat-template kwargs, and reasoning ships off, so
  // without a scale there is no way to switch it back on (ATO-527). Offer the
  // full one: a model with no thinking phase simply ignores the kwargs.
  const levels: ReasoningEffortLevel[] = !selectedModel
    ? []
    : selectedModel.reasoning
      ? availableReasoningLevels(selectedModel.reasoning)
      : usesTemplateReasoningKwargs(selectedProvider)
        ? ALL_LEVELS
        : []
  const level =
    reasoningBudget === 'off'
      ? undefined
      : resolveReasoningLevel(reasoningBudget, levels)

  // The level is only worth showing while reasoning is on: off, the model
  // answers without a thinking phase whatever the slider says.
  const shownLevel = enabled ? level : undefined
  const levelLabel = shownLevel
    ? t(`common:reasoningEffort.${shownLevel}`)
    : undefined

  return { enabled, canDisable, levels, level, shownLevel, levelLabel }
}
