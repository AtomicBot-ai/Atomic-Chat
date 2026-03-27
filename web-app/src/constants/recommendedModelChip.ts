export type RecommendedModelChipVariant =
  | 'gray'
  | 'green'
  | 'blue'
  | 'purple'
  | 'yellow'

//* Вариант чипа по i18n-ключу подписи
const VARIANT_BY_DESCRIPTION_KEY: Record<string, RecommendedModelChipVariant> = {
  'hub:recEverydayUse': 'green',
  'hub:recVisionKnowledge': 'purple',
  'hub:recFinetuningChat': 'blue',
  'hub:recMathReasoning': 'yellow',
}

export function chipVariantForRecommendedDescriptionKey(
  descriptionKey: string
): RecommendedModelChipVariant {
  return VARIANT_BY_DESCRIPTION_KEY[descriptionKey] ?? 'gray'
}
