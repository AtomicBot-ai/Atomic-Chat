import { useEffect, useMemo, useState } from 'react'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findCatalogModelForRecommendedRepo } from '@/lib/models'
import { findPinnedQuant, parseFileSizeToBytes } from '@/lib/model-card'
import { sanitizeModelId } from '@/lib/utils'
import {
  filterRecommendationsForPlatform,
  selectTierRecommendations,
  type Recommendation,
  type RecommendationPlatform,
} from '@/services/recommended-models-registry'
import {
  judgeMemoryFit,
  stepDownTier,
  type HardwareProfile,
  type HardwareTier,
} from '@/lib/hardware-tier'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import type { CatalogModel } from '@/services/models/types'

//* Стабильная ссылка: иначе селектор возвращал бы новый {} на каждый рендер.
const EMPTY_TIERS: Partial<Record<HardwareTier, Recommendation[]>> = {}

const currentOs: RecommendationPlatform = IS_MACOS
  ? 'macos'
  : IS_WINDOWS
    ? 'windows'
    : 'linux'

//* Сохраняем camelCase-форму, на которую завязаны Hub и SetupScreen.
type LegacyRecommendation = {
  modelName: string
  descriptionKey: string
  /** Pinned quant, if the manifest names one. See `findPinnedQuant`. */
  quant?: string
  /** Pinned multimodal projector quant, for vision entries. */
  mmprojQuant?: string
}

const toLegacy = (rec: Recommendation): LegacyRecommendation => ({
  modelName: rec.model_name,
  descriptionKey: rec.description_key,
  ...(rec.quant ? { quant: rec.quant } : {}),
  ...(rec.mmproj_quant ? { mmprojQuant: rec.mmproj_quant } : {}),
})

//* Не теряем разрешённые карточки при размонтировании Hub между переходами.
const resolvedModels: Record<string, CatalogModel> = {
  ...RECOMMENDED_MODEL_FALLBACKS,
}
const pendingModels = new Map<string, Promise<CatalogModel | null>>()

/**
 * Recommendations for this machine, **primary first**.
 *
 * Index 0 is the one model onboarding leads with — the rung of the ladder this
 * tier sits on. Everything after it is the "other options" pool: the manifest's
 * flat `recommendations` list, minus anything the tier already offered.
 *
 * Ordering is the contract, not a coincidence: the first screen renders
 * `items[0]` as the offer and the rest behind a disclosure, and
 * `recommended_model_shown.position` is this index.
 *
 * `profile` turns the measured ceiling into a gate rather than a caption: if
 * the rung's own model would not load on this machine (`judgeMemoryFit` says
 * `wont_load` — macOS past 0.85 of unified memory), the offer steps down the
 * ladder until one fits. Without it the screen could lead with a model and a
 * line saying it will not load, which is a warning where a recommendation was
 * promised. The bundled ladder already sits a rung light on macOS, so this
 * bites only on a manifest override or a machine at a bucket edge.
 */
export function useResolvedRecommendedModels(
  sources: CatalogModel[],
  tier: HardwareTier,
  profile: HardwareProfile | null = null
) {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const remoteRecommendations = useRecommendedModelsRegistryStore(
    (s) => s.recommendations
  )
  //* `?? {}` — персистнутый/замоканный стор может быть без нового поля.
  const tiers = useRecommendedModelsRegistryStore((s) => s.tiers ?? EMPTY_TIERS)

  const [fetched, setFetched] = useState<Record<string, CatalogModel>>(() => ({
    ...resolvedModels,
  }))

  const recommendations = useMemo<LegacyRecommendation[]>(() => {
    const rungFor = (candidate: HardwareTier) =>
      filterRecommendationsForPlatform(
        selectTierRecommendations(tiers, candidate),
        currentOs
      )
    // Size of the rung's lead, once its card has resolved. Unknown (not yet
    // fetched, or an MLX bundle whose size is spread over shards) reads as
    // "cannot judge", and an unjudged rung is kept — a guess must not demote.
    const leadSizeBytes = (recs: Recommendation[]): number | undefined => {
      const lead = recs[0]
      if (!lead) return undefined
      const model =
        findCatalogModelForRecommendedRepo(sources, lead.model_name) ??
        fetched[lead.model_name]
      if (!model || model.is_mlx) return undefined
      return parseFileSizeToBytes(
        findPinnedQuant(model.quants, lead.quant)?.file_size
      )
    }

    let forTier = rungFor(tier)
    for (
      let candidate: HardwareTier | null = tier;
      candidate;
      candidate = stepDownTier(candidate)
    ) {
      forTier = rungFor(candidate)
      if (judgeMemoryFit(leadSizeBytes(forTier), profile) !== 'wont_load') break
    }

    const rest = filterRecommendationsForPlatform(
      remoteRecommendations,
      currentOs
    )
    const seen = new Set(forTier.map((r) => r.model_name))
    return [...forTier, ...rest.filter((r) => !seen.has(r.model_name))].map(
      toLegacy
    )
  }, [remoteRecommendations, tiers, tier, profile, sources, fetched])

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
