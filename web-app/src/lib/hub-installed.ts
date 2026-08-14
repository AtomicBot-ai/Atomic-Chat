/**
 * "Installed on this device" list for the Hub.
 *
 * The Hub renders `CatalogModel` rows, but what is actually on disk is known
 * only to the provider registry: a model reaches it without ever appearing in
 * the curated catalog — a long-tail Hugging Face download, a manually imported
 * GGUF, or a local scan of LM Studio / Ollama / the HF cache. Filtering the
 * catalog down to installed entries therefore cannot show those models at all,
 * so the list is built from the installed models and merely *enriched* from the
 * catalog when an entry claims them.
 *
 * Kept free of React so the matching rules can be unit-tested directly.
 */

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { sanitizeModelId } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

/** Both llama.cpp providers register downloads: the fork and the upstream build. */
const LLAMACPP_PROVIDERS = ['llamacpp', 'llamacpp-upstream'] as const
const MLX_PROVIDER = 'mlx'

/**
 * The MLX engine sanitizes ids with its own rules (dots survive, spaces become
 * `-`), unlike `sanitizeModelId` which would collapse `.` into `_`. Mirrors
 * `MlxModelDownloadAction`.
 */
const sanitizeMlxId = (id: string): string =>
  id.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_./]/g, '')

type InstalledModel = { model: Model; isMlx: boolean }

/**
 * Installed local models keyed by provider model id. The same id can be
 * registered by more than one provider (the fork and the upstream build see the
 * same file); the first occurrence wins so the Hub lists one row.
 */
function collectLocalModels(
  providers: readonly ModelProvider[]
): Map<string, InstalledModel> {
  const out = new Map<string, InstalledModel>()

  const add = (models: readonly Model[], isMlx: boolean) => {
    for (const model of models) {
      // The embedding model is an app-internal download for retrieval, not
      // something the Hub can offer a chat with.
      if (model.embedding || model.id === EMBEDDING_MODEL_ID) continue
      if (out.has(model.id)) continue
      out.set(model.id, { model, isMlx })
    }
  }

  const modelsOf = (name: string) =>
    providers.find((provider) => provider.provider === name)?.models ?? []

  for (const name of LLAMACPP_PROVIDERS) add(modelsOf(name), false)
  add(modelsOf(MLX_PROVIDER), true)

  return out
}

/**
 * Provider model ids a catalog entry would produce once downloaded. Downloads
 * register either the bare id or a developer-prefixed one, so both spellings
 * count as a match.
 */
function candidateIds(entry: CatalogModel): string[] {
  const prefix = entry.developer ? `${entry.developer}/` : ''

  if (entry.is_mlx) {
    const shortName = entry.model_name.split('/').pop() ?? entry.model_name
    const id = sanitizeMlxId(shortName)
    return [id, `${prefix}${id}`]
  }

  return (entry.quants ?? []).flatMap((quant) => [
    quant.model_id,
    `${prefix}${sanitizeModelId(quant.model_id)}`,
  ])
}

/**
 * Row for an installed model the catalog does not carry. The single synthesized
 * quant is what `DownloadOptionsSelect` reads to recognise the model as present
 * and offer "New chat" instead of a download.
 */
function synthesizeEntry(id: string, installed: InstalledModel): CatalogModel {
  const [owner, ...rest] = id.split('/')
  const developer = rest.length > 0 ? owner : undefined

  const base: CatalogModel = {
    model_name: id,
    description: '',
    downloads: 0,
    developer,
    is_mlx: installed.isMlx,
  }

  if (installed.isMlx) return base

  return {
    ...base,
    num_quants: 1,
    quants: [{ model_id: id, path: installed.model.path ?? '', file_size: '' }],
  }
}

/**
 * Every model installed locally, as Hub rows: the catalog entry when one claims
 * the installed id (so its quant list, README and stats stay available), a
 * synthesized entry otherwise.
 */
export function collectInstalledModels(
  catalog: readonly CatalogModel[],
  providers: readonly ModelProvider[]
): CatalogModel[] {
  const installed = collectLocalModels(providers)
  if (installed.size === 0) return []

  const claimed = new Set<string>()
  const rows: CatalogModel[] = []

  for (const entry of catalog) {
    const matches = candidateIds(entry).filter((id) => installed.has(id))
    if (matches.length === 0) continue
    for (const id of matches) claimed.add(id)
    rows.push(entry)
  }

  for (const [id, model] of installed) {
    if (claimed.has(id)) continue
    rows.push(synthesizeEntry(id, model))
  }

  return rows
}

/**
 * Narrow the installed list by the Hub search box. The catalog search index
 * cannot answer this — it knows nothing about synthesized entries — so it is a
 * plain substring match over the id and its developer.
 */
export function filterInstalledBySearch(
  models: readonly CatalogModel[],
  searchValue: string
): CatalogModel[] {
  const query = searchValue.trim().toLowerCase()
  if (query.length === 0) return [...models]
  return models.filter((model) =>
    `${model.model_name} ${model.developer ?? ''}`.toLowerCase().includes(query)
  )
}
