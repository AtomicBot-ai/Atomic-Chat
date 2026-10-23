/**
 * The engines a Hub row can run on: the Engine filter's options and the Engines column.
 *
 * Each engine reads one Hub format, so picking an engine narrows the list to that format first.
 * This is catalog-level routing only: whether a model actually runs is still the download card's
 * verdict (fit, the core's managed and Foundry checks), never the file format's.
 */

import { getProviderTitle } from '@/lib/utils'
import { isManagedProvider } from '@/lib/managed-engines'
import { modelFormat, type ModelFormat } from '@/lib/model-card'
import type { CatalogModel } from '@/services/models/types'

export const HUB_ENGINES = [
  { id: 'llamacpp-upstream', format: 'gguf' },
  { id: 'llamacpp', format: 'gguf' },
  { id: 'mlx', format: 'mlx' },
  { id: 'atomic-prism', format: 'atomic-prism' },
  { id: 'vllm', format: 'vllm' },
  { id: 'sglang', format: 'sglang' },
  { id: 'tensorrt-llm', format: 'tensorrt-llm' },
  { id: 'foundry-local', format: 'foundry-local' },
  { id: 'litert-lm', format: 'litert-lm' },
] as const satisfies readonly { id: string; format: ModelFormat }[]

export type HubEngine = (typeof HUB_ENGINES)[number]
export type HubEngineId = HubEngine['id']

export const hubEngine = (id: unknown): HubEngine | undefined =>
  HUB_ENGINES.find((engine) => engine.id === id)

/** The engine's name as the rest of the app shows it (`getProviderTitle`). */
export const hubEngineLabel = (id: HubEngineId): string => getProviderTitle(id)

/** Bonsai's packing only PrismML's llama.cpp runs, although the files are GGUF. */
const PRISM_NAME = /prism[- ]?ml|bonsai/i
const PRISM_QUANT = /(?:PQ2_0|PTQ1_0)/i

/**
 * The engines that may run `model`, listed under `format` (the format the Hub shows). A managed
 * checkpoint is one for every managed engine, so it reads as the managed format on screen.
 */
export function modelEngineIds(
  model: CatalogModel,
  format?: ModelFormat
): HubEngineId[] {
  if (model.is_foundry_local) return ['foundry-local']
  if (model.is_litert_lm) return ['litert-lm']
  if (model.is_managed) {
    const engine = hubEngine(
      isManagedProvider(format) ? format : model.managed?.curatedBy
    )
    return engine && isManagedProvider(engine.id) ? [engine.id] : []
  }
  if (modelFormat(model) === 'mlx') return ['mlx']
  if (format === 'atomic-prism') return ['atomic-prism']
  const files = (model.quants ?? [])
    .map((quant) => `${quant.model_id} ${quant.path}`)
    .join(' ')
  if (
    PRISM_NAME.test(`${model.model_name} ${model.developer ?? ''}`) ||
    PRISM_QUANT.test(files)
  ) {
    return ['atomic-prism']
  }
  if (
    model.quants?.length ||
    model.library_name?.toLowerCase() === 'gguf' ||
    /gguf/i.test(model.model_name)
  ) {
    return ['llamacpp-upstream', 'llamacpp']
  }
  return []
}
