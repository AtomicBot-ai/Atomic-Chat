import { useEffect, useMemo, useRef, useState } from 'react'
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

  const [fetched, setFetched] = useState<Record<string, CatalogModel>>({ ...RECOMMENDED_MODEL_FALLBACKS })
  const fetchingRef = useRef(new Set<string>())

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
    //! fetchingRef уже гарантирует единственный in-flight запрос на модель
    //! и переживает StrictMode-перезапуски эффекта (тот же ref-объект).
    //! Раньше здесь был локальный `cancelled`-флаг замыкания, который
    //! выставлялся в true на cleanup ЛЮБОГО перезапуска эффекта (не только
    //! настоящего unmount) — например, когда `sources` донагружался
    //! асинхронно после монтирования. Из-за этого единственный реальный
    //! HF-фетч завершался с уже "отменённым" замыканием и результат тихо
    //! выбрасывался, а повторной попытки уже никто не запускал. setState
    //! на действительно размонтированном компоненте в React 18+ — безопасный
    //! no-op, так что отдельный флаг отмены не нужен.
    for (const rec of recommendations) {
      if (findCatalogModelForRecommendedRepo(sources, rec.modelName)) continue
      if (fetched[rec.modelName]) continue
      if (fetchingRef.current.has(rec.modelName)) continue
      fetchingRef.current.add(rec.modelName)

      void (async () => {
        try {
          const repo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(rec.modelName, huggingfaceToken)
          if (!repo) return
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
  }, [recommendations, sources, fetched, serviceHub, huggingfaceToken])

  return items
}
