import { projectStrataCollection } from '@atomic-chat/core/client'
import type { AtomicModelCatalog } from '@janhq/core'
import type { CatalogModel } from '@/services/models/types'
import { unifiedModelCatalog } from '@/services/unified-model-catalog'

export const DEFAULT_STRATA_QWEN38 = 'iq3-xxs-dflash2'

type HubDescriptor = NonNullable<CatalogModel['strata']> & { profile_id?: string }

const defaultProfiles = new Set([
  DEFAULT_STRATA_QWEN38,
  'ud-q4-k-xl-mtp',
  'ista-2-00bpw-dspark',
])

function isDefaultProfile(d: HubDescriptor) {
  return defaultProfiles.has(d.profile_id ?? d.variant_id)
}

function groupKey(d: HubDescriptor) {
  if (d.profile_id) {
    const weight = d.files.find(file => file.path === d.inputs.weights[0])
    const source = d.sources.find(source => source.id === weight?.source)
    return source ? `${d.family}/${source.host}/${source.repo}` : d.variant_id
  }
  const release = d.family === 'qwen38'
    ? /^(unsloth|swift|coder|gyro|nvfp4)-/.exec(d.variant_id)?.[1] ?? 'original'
    : ''
  return `${d.family}/${release}`
}

export function groupStrataCatalogRows(
  models: readonly CatalogModel[],
  backendId?: string
): CatalogModel[] {
  const groups = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const descriptor = model.strata
    if (!descriptor) continue
    if (backendId ? !descriptor.compatible_variants.includes(backendId) : !isDefaultProfile(descriptor))
      continue
    const key = groupKey(descriptor)
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }

  return [...groups.values()].map((group) => {
    const primary = group.find(({ strata }) => isDefaultProfile(strata!)) ?? group[0]!
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
