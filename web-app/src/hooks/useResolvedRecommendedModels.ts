import { useEffect, useMemo, useRef, useState } from 'react'
import { HUB_RECOMMENDED_MODELS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findCatalogModelForRecommendedRepo } from '@/lib/models'
import { sanitizeModelId } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

//* Рекомендации: каталог; если репо ещё не в индексе — один запрос к HF API
export function useResolvedRecommendedModels(sources: CatalogModel[]) {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const [fetched, setFetched] = useState<Record<string, CatalogModel>>({})
  const fetchingRef = useRef(new Set<string>())

  const items = useMemo(
    () =>
      HUB_RECOMMENDED_MODELS.map((rec) => ({
        rec,
        model:
          findCatalogModelForRecommendedRepo(sources, rec.modelName) ??
          fetched[rec.modelName] ??
          null,
      })),
    [sources, fetched]
  )

  useEffect(() => {
    let cancelled = false

    for (const rec of HUB_RECOMMENDED_MODELS) {
      if (findCatalogModelForRecommendedRepo(sources, rec.modelName)) continue
      if (fetched[rec.modelName]) continue
      if (fetchingRef.current.has(rec.modelName)) continue
      fetchingRef.current.add(rec.modelName)

      void (async () => {
        try {
          const repo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(rec.modelName, huggingfaceToken)
          if (cancelled || !repo) return
          const catalog = serviceHub.models().convertHfRepoToCatalogModel(repo)
          const processed: CatalogModel = {
            ...catalog,
            quants: catalog.quants?.map((quant) => ({
              ...quant,
              model_id: sanitizeModelId(quant.model_id),
            })),
            is_mlx: catalog.library_name === 'mlx',
          }
          //! Как в useModelSources: MLX только на macOS
          if (!IS_MACOS && processed.is_mlx) return
          setFetched((prev) =>
            prev[rec.modelName] ? prev : { ...prev, [rec.modelName]: processed }
          )
        } catch (e) {
          console.error('Recommended model HF fetch failed', rec.modelName, e)
        } finally {
          fetchingRef.current.delete(rec.modelName)
        }
      })()
    }

    return () => {
      cancelled = true
    }
  }, [sources, fetched, serviceHub, huggingfaceToken])

  return items
}
