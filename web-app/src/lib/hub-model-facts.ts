/**
 * What a row of the Hub's local models table says about a model, from what the listing carries.
 *
 * Kept free of React so the table, its expanded row and the column sort read one set of numbers.
 * Nothing here fetches: a size the row does not know yet stays unknown until the card fetched for
 * it arrives.
 */

import { modelEngineIds, type HubEngineId } from '@/lib/hub-model-engines'
import { modelDownloadSizeText } from '@/lib/hub-filters'
import { estimateWeightBytes } from '@/lib/managed-engine/hub-feed'
import { isManagedProvider } from '@/lib/managed-engines'
import {
  deriveCapabilities,
  deriveParams,
  estimateFit,
  formatParamCount,
  modelFormat,
  parseFileSizeToBytes,
  type Capability,
  type HardwareFit,
  type ModelFormat,
} from '@/lib/model-card'
import { foundryLocalOf } from '@/lib/foundry-local/hub'
import { liteRtLmOf } from '@/lib/litert-lm/hub'
import { extractModelName } from '@/lib/models'
import { formatBytes } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'
import type {
  StaffPick,
  StaffPickCategory,
} from '@/services/staff-picks-registry'

/** The name a row shows: a Foundry or LiteRT-LM model's own, the pick's title, or the repo's. */
export function hubModelName(model: CatalogModel, pick?: StaffPick): string {
  return (
    foundryLocalOf(model)?.name ||
    liteRtLmOf(model)?.name ||
    pick?.title ||
    extractModelName(model.model_name) ||
    model.model_name
  )
}

/** The repository a Hub entry downloads from, as Hugging Face names it. */
export const hubRepoId = (model: CatalogModel): string =>
  model.model_name.includes('/')
    ? model.model_name
    : `${model.developer ? `${model.developer}/` : ''}${model.model_name}`

export type HubModelFacts = {
  /**
   * "9B"; from the name, or the safetensors listing's parameter counts. The table fills
   * in Hugging Face's own count for a name that carries none (`useHubModelParams`).
   */
  params?: string
  format: ModelFormat
  capabilities: Capability[]
  /** The representative download the row quotes ("5.2 GB"). */
  sizeText?: string
  sizeBytes?: number
  /**
   * The size against this device's memory, as the download card's badge reads it
   * (`estimateFit`). Absent while the size or the memory reading is unknown, and for the
   * models whose fit is the core's verdict in the card: a managed engine's checkpoint, a
   * Foundry Local or LiteRT-LM variant.
   */
  fit?: HardwareFit
  engines: HubEngineId[]
}

const liteRtCategories = (model: NonNullable<ReturnType<typeof liteRtLmOf>>): StaffPickCategory[] => [
  ...(model.vision ? (['vision'] as const) : []),
  ...(model.tools ? (['tools'] as const) : []),
  ...(model.reasoning ? (['reasoning'] as const) : []),
]

export function hubModelFacts(
  model: CatalogModel,
  options: {
    /** The format the Hub shows: a managed checkpoint reads as it. */
    format?: ModelFormat
    budgetBytes: number
    categories?: readonly StaffPickCategory[]
  }
): HubModelFacts {
  const foundry = model.is_foundry_local ? model.foundry_local : undefined
  const liteRt = liteRtLmOf(model)
  const managedWeights = model.is_managed
    ? estimateWeightBytes(model.managed?.parameters)
    : null
  const managedParams = model.is_managed
    ? Object.values(model.managed?.parameters ?? {}).reduce(
        (total, count) => total + count,
        0
      )
    : 0

  let sizeBytes: number | undefined
  let sizeText: string | undefined
  if (model.is_managed) {
    sizeBytes = managedWeights ?? undefined
    sizeText = sizeBytes ? formatBytes(sizeBytes) : undefined
  } else if (!foundry && !liteRt) {
    sizeText = modelDownloadSizeText(model)
    sizeBytes = parseFileSizeToBytes(sizeText)
  }

  const verdictInCard = model.is_managed || !!foundry || !!liteRt
  const fit =
    !verdictInCard && sizeBytes && options.budgetBytes > 0
      ? estimateFit(sizeBytes, options.budgetBytes)
      : undefined

  return {
    params: formatParamCount(managedParams) ?? deriveParams(model),
    format: modelFormat(
      model,
      isManagedProvider(options.format) ? options.format : undefined
    ),
    // A LiteRT-LM model's are what its list says, never guessed from its name: a Hugging Face
    // model's are read from the file after download.
    capabilities: deriveCapabilities(model, liteRt ? liteRtCategories(liteRt) : options.categories),
    sizeText,
    sizeBytes,
    fit,
    engines: modelEngineIds(model, options.format),
  }
}

/** The order the table's sortable columns compare in; `undefined` sorts last either way. */
export type HubSortableColumn =
  | 'model'
  | 'parameters'
  | 'format'
  | 'downloadSize'
  | 'engines'

const parseScaled = (
  text: string | undefined,
  scale: Record<string, number>
): number | undefined => {
  const match = text?.match(/^(\d+(?:\.\d+)?)\s*([A-Z])?$/i)
  if (!match) return undefined
  return Number(match[1]) * (scale[(match[2] ?? '').toUpperCase()] ?? 1)
}

export function hubSortValue(
  name: string,
  facts: HubModelFacts,
  column: HubSortableColumn,
  engineLabel: (id: HubEngineId) => string
): string | number | undefined {
  switch (column) {
    case 'model':
      return name
    case 'parameters':
      return parseScaled(facts.params, { B: 1e9, M: 1e6 })
    case 'format':
      return facts.format
    case 'downloadSize':
      return facts.sizeBytes
    case 'engines':
      return facts.engines.map(engineLabel).join(', ') || undefined
  }
}
