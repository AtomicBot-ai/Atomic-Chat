/**
 * Foundry Local models as Model Hub entries (change `add-foundry-local`, spec "Model Hub предлагает
 * модели Foundry Local"): a curated model of conf's list or a chat model of Microsoft's catalog,
 * shaped as the Hub's `CatalogModel` with its variants under `foundry_local`.
 *
 * `model_name` is `foundry-local/<model id>`: the Hub keys rows and its `?model=` link by it, and
 * the prefix keeps it apart from any Hugging Face repository.
 */

import type { FoundryLocalModel } from '@/services/foundry-local/curated'
import type { CatalogModel as MicrosoftModel } from '@/services/foundry-local/microsoft-catalog'
import type { FoundryLocalHubModel } from '@/services/foundry-local/types'
import type { CatalogModel } from '@/services/models/types'

export const FOUNDRY_LOCAL_HUB_PREFIX = 'foundry-local/'

/** A Foundry Local entry's own fields, or `undefined` for any other Hub entry. */
export function foundryLocalOf(model: CatalogModel | null | undefined): FoundryLocalHubModel | undefined {
  return model?.is_foundry_local ? model.foundry_local : undefined
}

function card(fields: FoundryLocalHubModel): CatalogModel {
  return {
    model_name: `${FOUNDRY_LOCAL_HUB_PREFIX}${fields.model_id}`,
    description: fields.summary,
    downloads: 0,
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
    is_foundry_local: true,
    foundry_local: fields,
  }
}

/** A model of conf's curated list: its variants with their files, sizes and sha256. */
export function curatedHubCard(model: FoundryLocalModel): CatalogModel {
  return card({
    origin: 'curated',
    model_id: model.id,
    name: model.name,
    summary: model.description,
    license: model.license,
    context_length: model.context_length,
    tools: model.tools,
    reasoning: model.reasoning,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      device: variant.device,
      execution_provider: variant.execution_provider,
      platforms: variant.platforms,
      asset_id: variant.source.asset_id,
      version: variant.source.version,
      size_bytes: variant.files.reduce((total, file) => total + file.size, 0),
      ...(variant.context_length ? { context_length: variant.context_length } : {}),
      files: variant.files,
      path_prefix: variant.source.path_prefix,
    })),
  })
}

/** A chat model of Microsoft's catalog: no files, no context, tool calling or reasoning yet. */
export function catalogHubCard(model: MicrosoftModel): CatalogModel {
  return card({
    origin: 'microsoft',
    model_id: model.id,
    name: model.name,
    summary: model.license ?? '',
    license: model.license,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      device: variant.device,
      execution_provider: variant.execution_provider,
      platforms: variant.platforms,
      asset_id: variant.asset_id,
      version: variant.version,
      size_bytes: variant.size_bytes,
    })),
  })
}

/** Whether `query` names the entry: every word in its id, name or summary, case aside. */
export function foundryLocalMatches(model: CatalogModel, query: string): boolean {
  const fields = foundryLocalOf(model)
  if (!fields) return false
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${fields.model_id} ${fields.name} ${fields.summary}`.toLowerCase()
  return words.every((word) => text.includes(word))
}
