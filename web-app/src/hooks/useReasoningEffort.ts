import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { modelReasoningEffort } from '@/lib/reasoning-effort'

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

  const { enabled, canDisable, levels, level, shownLevel } =
    modelReasoningEffort(
      selectedProvider,
      selectedModel,
      disableReasoning,
      reasoningBudget
    )
  const levelLabel = shownLevel
    ? t(`common:reasoningEffort.${shownLevel}`)
    : undefined

  return {
    enabled,
    canDisable,
    preferenceDisabled: disableReasoning,
    hasModel: Boolean(selectedModel),
    levels,
    level,
    shownLevel,
    levelLabel,
  }
}
