import { useEffect, useMemo, useState } from 'react'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findCatalogModelForRecommendedRepo } from '@/lib/models'
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

//* Не теряем разрешённые карточки при размонтировании Hub между переходами.
const resolvedModels: Record<string, CatalogModel> = {
  ...RECOMMENDED_MODEL_FALLBACKS,
}
const pendingModels = new Map<string, Promise<CatalogModel | null>>()

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
 * going to show.
 */
export function useStaffPicks(
  sources: CatalogModel[],
  format: StaffPickFormat = 'gguf'
): ResolvedStaffPick[] {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const remotePicks = useStaffPicksStore((s) => s.picks)

  const picks = useMemo(
    () => filterStaffPicksForPlatform(remotePicks, currentOs, format),
    [remotePicks, format]
  )

  const [fetched, setFetched] = useState<Record<string, CatalogModel>>(() => ({
    ...resolvedModels,
  }))

  const items = useMemo<ResolvedStaffPick[]>(
    () =>
      picks.map((pick) => ({
        pick,
        model:
          findCatalogModelForRecommendedRepo(sources, pick.model_name) ??
          fetched[pick.model_name] ??
          null,
      })),
    [picks, sources, fetched]
  )

  useEffect(() => {
    let active = true

    for (const pick of picks) {
      if (findCatalogModelForRecommendedRepo(sources, pick.model_name)) continue
      if (fetched[pick.model_name]) continue

      let pending = pendingModels.get(pick.model_name)
      if (!pending) {
        pending = (async () => {
          const repo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(pick.model_name, huggingfaceToken)
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
          resolvedModels[pick.model_name] = processed
          return processed
        })()
        pendingModels.set(pick.model_name, pending)
        const clearPending = () => {
          if (pendingModels.get(pick.model_name) === pending) {
            pendingModels.delete(pick.model_name)
          }
        }
        void pending.then(clearPending, clearPending)
      }

      void pending
        .then((processed) => {
          if (!active || !processed) return
          setFetched((prev) =>
            prev[pick.model_name]
              ? prev
              : { ...prev, [pick.model_name]: processed }
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
