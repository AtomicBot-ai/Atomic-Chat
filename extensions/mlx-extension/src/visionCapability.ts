type JsonObject = Record<string, unknown>

const MULTIMODAL_WEIGHT_MARKERS = [
  'vision_model',
  'vision_tower',
  'visual.',
  'vl_connector',
  'projector',
  'image_newline',
  'image_token',
  'img_projector',
  'multi_modal',
  'multimodal',
  'perceiver',
]

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMultimodalWeight(name: string): boolean {
  const normalized = name.toLowerCase()
  return MULTIMODAL_WEIGHT_MARKERS.some((marker) =>
    normalized.includes(marker)
  )
}

export function classifyMlxVisionCapability(
  config: unknown,
  safetensorsIndex?: unknown
): boolean {
  if (
    !isObject(config) ||
    !isObject(config.vision_config) ||
    Object.keys(config.vision_config).length === 0
  ) {
    return false
  }

  if (safetensorsIndex === undefined) {
    return true
  }

  if (!isObject(safetensorsIndex)) {
    return false
  }

  const weightMap = safetensorsIndex.weight_map
  if (!isObject(weightMap)) {
    return false
  }

  return Object.keys(weightMap).some(isMultimodalWeight)
}
