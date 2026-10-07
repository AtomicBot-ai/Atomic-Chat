/**
 * Pure logic behind the Hub's Images, Video, Decision and Embedding
 * categories.
 *
 * Chat models come from the open Hugging Face catalog; image and video models
 * do not. A diffusion checkpoint only runs with the VAE and text encoders the
 * curated catalog pairs it with, so these categories list that catalog and
 * nothing else — the same families the Images and Video pages offer. Decision
 * and embedding models likewise come from their own curated catalogs only.
 */

import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import type { DiffusionModality } from '@/services/diffusion/types'
import type {
  DiffusionCatalog,
  DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'
import { artifactId } from '@/lib/diffusion/models'

export type HubCategory = 'chat' | DiffusionModality | 'decision' | 'embedding'

export const HUB_CATEGORIES: readonly HubCategory[] = [
  'chat',
  'image',
  'video',
  'decision',
  'embedding',
]

export const isHubCategory = (value: unknown): value is HubCategory =>
  typeof value === 'string' && HUB_CATEGORIES.includes(value as HubCategory)

/** Families of one modality that the bundled sd.cpp engine can run. */
export function mediaFamilies(
  catalog: DiffusionCatalog | null,
  modality: DiffusionModality
): DiffusionCatalogFamily[] {
  return (catalog?.families ?? []).filter(
    (family) =>
      family.modality === modality &&
      family.engines.includes('sdcpp') &&
      family.transformer.quants.length > 0
  )
}

/**
 * Every word of the query has to appear in the family's name, developer,
 * description or repo — the catalog is a dozen entries, so a plain substring
 * match is all the search it needs.
 */
export function filterFamiliesBySearch(
  families: readonly DiffusionCatalogFamily[],
  query: string
): DiffusionCatalogFamily[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...families]
  return families.filter((family) => {
    const haystack = [
      family.name,
      family.developer,
      family.description,
      family.transformer.repo,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * The Decision category's search: every word in the model's name,
 * description, repo or backbone.
 */
export function filterDecisionModels(
  models: readonly DecisionCatalogModel[],
  query: string
): DecisionCatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...models]
  return models.filter((model) => {
    const haystack = [model.name, model.description, model.repo, model.backbone]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * The Embedding category's search: every word in the model's name,
 * description or repo.
 */
export function filterEmbeddingModels(
  models: readonly EmbeddingCatalogModel[],
  query: string
): EmbeddingCatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...models]
  return models.filter((model) => {
    const haystack = [model.name, model.description, model.repo]
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/** Does any quant of the family have files on disk, complete or not? */
export function familyIsInstalled(
  family: DiffusionCatalogFamily,
  installedIds: ReadonlySet<string>
): boolean {
  return family.transformer.quants.some((quant) =>
    installedIds.has(artifactId(family.id, quant.id))
  )
}

/** Installed families first, each group in catalog order. */
export function splitByInstalled(
  families: readonly DiffusionCatalogFamily[],
  installedIds: ReadonlySet<string>
): {
  installed: DiffusionCatalogFamily[]
  available: DiffusionCatalogFamily[]
} {
  const installed: DiffusionCatalogFamily[] = []
  const available: DiffusionCatalogFamily[] = []
  for (const family of families) {
    if (familyIsInstalled(family, installedIds)) installed.push(family)
    else available.push(family)
  }
  return { installed, available }
}
