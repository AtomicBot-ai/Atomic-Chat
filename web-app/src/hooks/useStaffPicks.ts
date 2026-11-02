import { useEffect, useMemo, useState } from 'react'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { pinnedRecommendationModel } from '@/services/models/hf-catalog'
import { sanitizeModelId } from '@/lib/utils'
import {
  filterStaffPicksForPlatform,
  type StaffPick,
  type StaffPickFormat,
  type StaffPickPlatform,
} from '@/services/staff-picks-registry'
import { useStaffPicksStore } from '@/stores/staff-picks-store'
import type { CatalogModel } from '@/services/models/types'

const currentOs: StaffPickPlatform = IS_MACOS
  ? 'macos'
  : IS_WINDOWS
    ? 'windows'
    : 'linux'

export type ResolvedStaffPick = {
  pick: StaffPick
  model: CatalogModel | null
}

//* Don't lose resolved cards when Hub unmounts between navigations.
const resolvedModels: Record<string, CatalogModel> = {
  ...RECOMMENDED_MODEL_FALLBACKS,
}
const pendingModels = new Map<string, Promise<CatalogModel | null>>()
const modelKey = (repo: string, revision?: string) =>
  revision ? `${repo}@${revision}` : repo

/** Test seam: drop memoized resolutions between cases. */
export const __resetStaffPickResolutionCache = () => {
  for (const key of Object.keys(resolvedModels)) delete resolvedModels[key]
  Object.assign(resolvedModels, RECOMMENDED_MODEL_FALLBACKS)
  pendingModels.clear()
}

/**
 * Resolve curated staff picks into full catalog models.
 *
 * The manifest only carries a repo id plus presentation metadata; the heavy
 * `CatalogModel` (quants, mmproj, file sizes) comes from the curated catalog
 * when the repo is indexed there, and from a single Hugging Face API call
 * otherwise.
 *
 * `format` narrows the manifest before any of that work happens: the curated
 * list carries a GGUF and an MLX entry for most models, and resolving both
 * would double the Hugging Face round-trips to populate rows the Hub is not
 * going to show. `only` narrows it further for a caller that wants one slice
 * of the list (the composer's vision offer) without resolving the rest.
 */
export function useStaffPicks(
  sources: CatalogModel[],
  format: StaffPickFormat = 'gguf',
  only?: (pick: StaffPick) => boolean
): ResolvedStaffPick[] {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const remotePicks = useStaffPicksStore((s) => s.picks)

  const picks = useMemo(() => {
    const forPlatform = filterStaffPicksForPlatform(
      remotePicks,
      currentOs,
      format
    )
    return only ? forPlatform.filter(only) : forPlatform
  }, [remotePicks, format, only])

  const [fetched, setFetched] = useState<Record<string, CatalogModel>>(() => ({
    ...resolvedModels,
  }))

  const items = useMemo<ResolvedStaffPick[]>(
    () =>
      picks.map((pick) => ({
        pick,
        model:
          pinnedRecommendationModel(sources, pick.model_name, pick.revision) ??
          fetched[modelKey(pick.model_name, pick.revision)] ??
          null,
      })),
    [picks, sources, fetched]
  )

  useEffect(() => {
    let active = true

    for (const pick of picks) {
      if (pinnedRecommendationModel(sources, pick.model_name, pick.revision))
        continue
      if (fetched[modelKey(pick.model_name, pick.revision)]) continue

      const key = modelKey(pick.model_name, pick.revision)
      let pending = pendingModels.get(key)
      if (!pending) {
        pending = (async () => {
          const repo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(
              pick.model_name,
              huggingfaceToken,
              pick.revision
            )
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
          //! Same as in useModelSources: MLX only on macOS
          if (!IS_MACOS && processed.is_mlx) return null
          resolvedModels[key] = processed
          return processed
        })()
        pendingModels.set(key, pending)
        const clearPending = () => {
          if (pendingModels.get(key) === pending) {
            pendingModels.delete(key)
          }
        }
        void pending.then(clearPending, clearPending)
      }

      void pending
        .then((processed) => {
          if (!active || !processed) return
          setFetched((prev) =>
            prev[key] ? prev : { ...prev, [key]: processed }
          )
        })
        .catch((e) => {
          console.error('Staff pick HF fetch failed', pick.model_name, e)
        })
    }

    return () => {
      active = false
    }
  }, [picks, sources, fetched, serviceHub, huggingfaceToken])

  return items
}
