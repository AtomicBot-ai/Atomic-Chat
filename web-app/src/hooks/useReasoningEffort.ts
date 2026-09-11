import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  availableReasoningLevels,
  resolveReasoningLevel,
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

  const enabled = !disableReasoning

  // No model picked yet, or one without a thinking phase: no scale, so no
  // level on the pill. The stored preference is kept for the next pick.
  const levels: ReasoningEffortLevel[] = selectedModel
    ? availableReasoningLevels(selectedModel.reasoning)
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

  return { enabled, levels, level, shownLevel, levelLabel }
}
