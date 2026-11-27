import { ggufMatchIds } from '@/lib/onboarding/jobs'
import { sanitizeModelId } from '@/lib/utils'
import { getCatalogSync } from '@/stores/model-catalog-store'

export function installedGgufSource(model: string) {
  // Use the importer's exact variant ids for older installs with no source_repo.
  const matches = getCatalogSync().filter((repo) =>
    repo.quants?.some((q) =>
      ggufMatchIds(repo.developer, sanitizeModelId(q.model_id)).includes(model)
    )
  )
  return matches.length === 1 ? matches[0].model_name : undefined
}
