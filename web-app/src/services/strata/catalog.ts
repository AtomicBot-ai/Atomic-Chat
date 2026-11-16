import { projectStrataCollection } from '@atomic-chat/core/client'
import type { AtomicModelCatalog } from '@janhq/core'
import type { CatalogModel } from '@/services/models/types'
import { unifiedModelCatalog } from '@/services/unified-model-catalog'

export const DEFAULT_STRATA_QWEN38 = 'iq3-xxs-dflash2'

export function groupStrataCatalogRows(
  models: readonly CatalogModel[],
  backendId?: string
): CatalogModel[] {
  const defaultVariants = new Set([
    DEFAULT_STRATA_QWEN38,
    'ud-q4-k-xl-mtp',
    'ista-2-00bpw-dspark',
  ])
  const groups = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const descriptor = model.strata
    if (!descriptor) continue
    const id = descriptor.variant_id
    if (backendId ? !descriptor.compatible_variants.includes(backendId) : !defaultVariants.has(id))
      continue
    const release = descriptor.family === 'qwen38'
      ? /^(unsloth|swift|coder|gyro|nvfp4)-/.exec(id)?.[1] ?? 'original'
      : ''
    const key = `${descriptor.family}/${release}`
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }

  return [...groups.values()].map((group) => {
    const primary = group.find(({ strata }) => defaultVariants.has(strata!.variant_id)) ?? group[0]!
    return group.length > 1
      ? { ...primary, strataVariants: group.map(({ strata }) => strata!) }
      : primary
  })
}

export function strataCatalogRows(catalog: AtomicModelCatalog): CatalogModel[] {
  return projectStrataCollection(catalog).models.map((descriptor) => ({
    model_name: `strata/${descriptor.variant_id}`,
    description: descriptor.name,
    downloads: 0,
    strata: descriptor,
  }))
}

export async function fetchStrataCatalog() {
  return strataCatalogRows(await unifiedModelCatalog())
}
