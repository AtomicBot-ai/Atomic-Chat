import { projectFastFlowLmCollection } from '@atomic-chat/core/client'
import type { AtomicModelCatalog } from '@janhq/core'
import { unifiedModelCatalog } from '@/services/unified-model-catalog'

/** The SDK validates complete file plans; a valid catalog without FLM remains empty. */
export function fastFlowLmModels(catalog: AtomicModelCatalog) {
  return projectFastFlowLmCollection(catalog).models.sort(
    (a, b) =>
      Number(!!b.recommended) - Number(!!a.recommended) ||
      a.name.localeCompare(b.name)
  )
}

export async function fetchFastFlowLmModels(force = false) {
  return fastFlowLmModels(await unifiedModelCatalog(force))
}
