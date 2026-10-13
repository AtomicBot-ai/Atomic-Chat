import { isManagedDownloadId } from '@/lib/managed-engine/download-id'
import type { CatalogModel } from '@/services/models/types'
import {
  recentFailedDownloads,
  type FailedDownload,
} from '@/stores/failed-downloads-store'

/** Failed repositories stay discoverable even after falling out of the catalog. */
export function failedDownloadModels(
  failures: readonly FailedDownload[],
  catalog: readonly CatalogModel[],
  details: ReadonlyMap<string, CatalogModel>,
  query: string,
  now = Date.now()
): CatalogModel[] {
  const seen = new Set<string>()
  const normalized = query.trim().toLowerCase()
  return recentFailedDownloads(failures, now).flatMap((failure) => {
    if (
      seen.has(failure.repo) ||
      !failure.repo.toLowerCase().includes(normalized)
    )
      return []
    seen.add(failure.repo)
    const model = details.get(failure.repo) ??
      catalog.find((model) => model.model_name === failure.repo) ?? {
        model_name: failure.repo,
        description: '',
        downloads: 0,
        is_mlx: failure.isMlx,
      }
    return [
      isManagedDownloadId(failure.modelId)
        ? { ...model, is_managed: true }
        : model,
    ]
  })
}
