import { useEffect, useMemo, useState } from 'react'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findCatalogModelForRecommendedRepo } from '@/lib/models'
import { sanitizeModelId } from '@/lib/utils'
import {
  filterRecommendationsForPlatform,
  type Recommendation,
  type RecommendationPlatform,
} from '@/services/recommended-models-registry'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import type { CatalogModel } from '@/services/models/types'

const currentOs: RecommendationPlatform = IS_MACOS
  ? 'macos'
  : IS_WINDOWS
    ? 'windows'
    : 'linux'

//* Сохраняем camelCase-форму, на которую завязаны Hub и SetupScreen.
type LegacyRecommendation = {
  modelName: string
  descriptionKey: string
}

const toLegacy = (rec: Recommendation): LegacyRecommendation => ({
  modelName: rec.model_name,
  descriptionKey: rec.description_key,
})

//* Не теряем разрешённые карточки при размонтировании Hub между переходами.
const resolvedModels: Record<string, CatalogModel> = {
  ...RECOMMENDED_MODEL_FALLBACKS,
}
const pendingModels = new Map<string, Promise<CatalogModel | null>>()

//* Рекомендации: каталог; если репо ещё не в индексе — один запрос к HF API
export function useResolvedRecommendedModels(sources: CatalogModel[]) {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const remoteRecommendations = useRecommendedModelsRegistryStore(
    (s) => s.recommendations
  )

  const recommendations = useMemo<LegacyRecommendation[]>(
    () =>
      filterRecommendationsForPlatform(remoteRecommendations, currentOs).map(
        toLegacy
      ),
    [remoteRecommendations]
  )

  const [fetched, setFetched] = useState<Record<string, CatalogModel>>(() => ({
    ...resolvedModels,
  }))

  const items = useMemo(
    () =>
      recommendations.map((rec) => ({
        rec,
        model:
          findCatalogModelForRecommendedRepo(sources, rec.modelName) ??
          fetched[rec.modelName] ??
          null,
      })),
    [recommendations, sources, fetched]
  )

  useEffect(() => {
    let active = true

    for (const rec of recommendations) {
      if (findCatalogModelForRecommendedRepo(sources, rec.modelName)) continue
      if (fetched[rec.modelName]) continue

      let pending = pendingModels.get(rec.modelName)
      if (!pending) {
        pending = (async () => {
          const repo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(rec.modelName, huggingfaceToken)
          if (!repo) return null
          const catalog = serviceHub.models().convertHfRepoToCatalogModel(repo)
          const processed: CatalogModel = {
            ...catalog,
            quants: catalog.quants?.map((quant) => ({
              ...quant,
              model_id: sanitizeModelId(quant.model_id),
            })),
            is_mlx: catalog.is_mlx ?? catalog.library_name === 'mlx',
          }
          //! Как в useModelSources: MLX только на macOS
          if (!IS_MACOS && processed.is_mlx) return null
          resolvedModels[rec.modelName] = processed
          return processed
        })()
        pendingModels.set(rec.modelName, pending)
        const clearPending = () => {
          if (pendingModels.get(rec.modelName) === pending) {
            pendingModels.delete(rec.modelName)
          }
        }
        void pending.then(clearPending, clearPending)
      }

      void pending
        .then((processed) => {
          if (!active || !processed) return
          setFetched((prev) =>
            prev[rec.modelName] ? prev : { ...prev, [rec.modelName]: processed }
          )
        })
        .catch((e) => {
          console.error('Recommended model HF fetch failed', rec.modelName, e)
        })
    }

    return () => {
      active = false
    }
  }, [recommendations, sources, fetched, serviceHub, huggingfaceToken])

  return items
}
