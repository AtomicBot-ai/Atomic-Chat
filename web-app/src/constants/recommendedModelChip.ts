export type RecommendedModelChipVariant =
  | 'gray'
  | 'green'
  | 'blue'
  | 'purple'
  | 'yellow'
  | 'orange'

//* Chip variant by the label's i18n key
const VARIANT_BY_DESCRIPTION_KEY: Record<string, RecommendedModelChipVariant> = {
  'hub:recEverydayUse': 'green',
  'hub:recVisionKnowledge': 'purple',
  'hub:recFinetuningChat': 'blue',
  'hub:recMathReasoning': 'yellow',
  'hub:recCoding': 'blue',
  'hub:recForMlx': 'orange',
}

export function chipVariantForRecommendedDescriptionKey(
  descriptionKey: string
): RecommendedModelChipVariant {
  return VARIANT_BY_DESCRIPTION_KEY[descriptionKey] ?? 'gray'
}
