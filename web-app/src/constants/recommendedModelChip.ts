export type RecommendedModelChipVariant =
  | 'gray'
  | 'green'
  | 'blue'
  | 'purple'
  | 'yellow'
  | 'orange'

//* Вариант чипа по i18n-ключу подписи
const VARIANT_BY_DESCRIPTION_KEY: Record<string, RecommendedModelChipVariant> = {
  'hub:recEverydayUse': 'green',
  'hub:recVisionKnowledge': 'purple',
  'hub:recFinetuningChat': 'blue',
  'hub:recMathReasoning': 'yellow',
  'hub:recForMlx': 'orange',
}

export function chipVariantForRecommendedDescriptionKey(
  descriptionKey: string
): RecommendedModelChipVariant {
  return VARIANT_BY_DESCRIPTION_KEY[descriptionKey] ?? 'gray'
}
