import { useMemo } from 'react'

import { SETUP_SCREEN_QUANTIZATIONS } from '@/constants/models'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelSources } from '@/hooks/useModelSources'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { judgeMemoryFit, type MemoryFit } from '@/lib/hardware-tier'
import { findPinnedQuant, parseFileSizeToBytes } from '@/lib/model-card'
import { prettyModelName } from '@/lib/model-display-name'
import { getPreferredMmprojModel, getTotalDownloadFileSize } from '@/lib/models'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import type {
  CatalogModel,
  MMProjModel,
  ModelQuant,
} from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'

export type VisionDownload = {
  /** Hugging Face repo id, e.g. `AtomicChat/gemma-4-E4B-it-GGUF`. */
  repo: string
  title: string
  /** i18n key for the one-line reason (the Hub category label). */
  hint: string
  /** Staff-pick icon key, when the manifest names one. */
  icon?: string
  /** Weights plus the projector that will be fetched with them. */
  sizeLabel?: string
  model: CatalogModel
  /** The exact weights file a download would fetch. */
  variant: ModelQuant
  isDownloading: boolean
  /** Already in the local provider: nothing to download, only to switch to. */
  installed: boolean
  /** Starts the download. Returns the model id started, or `null` if it could not. */
  start: () => string | null
}

/**
 * Where a row came from decides only its place among equals: the manifest's
 * own vision entries before the staff picks, each list in its own order.
 */
type Candidate = {
  repo: string
  title: string
  hint: string
  icon?: string
  model: CatalogModel
  quantPin?: string
  mmprojPin?: string
}

const isVisionPick = (pick: StaffPick): boolean =>
  pick.categories?.includes('vision') ?? false

/** Lower loads better. Unknown sits last: a guess must not outrank a fact. */
const FIT_RANK: Record<MemoryFit, number> = {
  comfortable: 0,
  tight: 1,
  spills: 2,
  wont_load: 3,
}

const pickVariant = (model: CatalogModel, pin?: string): ModelQuant | null => {
  const pinned = findPinnedQuant(model.quants, pin)
  if (pinned) return pinned
  for (const quantization of SETUP_SCREEN_QUANTIZATIONS) {
    const found = model.quants?.find((q) =>
      q.model_id.toLowerCase().includes(quantization)
    )
    if (found) return found
  }
  return model.quants?.[0] ?? null
}

const pickProjector = (
  model: CatalogModel,
  pin?: string
): MMProjModel | undefined =>
  findPinnedQuant(model.mmproj_models, pin) ?? getPreferredMmprojModel(model)

/**
 * The vision models this machine can run, best fit first, each with the
 * download behind it — what the composer offers when the model in use cannot
 * take an image.
 *
 * In llama.cpp a model sees through a multimodal projector (`mmproj-*.gguf`)
 * trained for that exact checkpoint, so "get vision" always means "download a
 * vision-language model together with its projector". A row is a repo that
 * ships one: the manifest's vision entries for this tier (`mmproj_quant`) and
 * the staff picks curated as `vision`, kept only once their card confirms a
 * projector is there to fetch.
 *
 * GGUF only, like the reply gate: it is the format every platform runs. Rows
 * the memory judge says would not load here are dropped rather than shown
 * with a warning; the rest are ordered comfortable → tight → spills, a model
 * already on disk ahead of them all.
 */
export function useVisionDownloads(limit = 5): {
  items: VisionDownload[]
  isLoading: boolean
} {
  const serviceHub = useServiceHub()
  const { sources } = useModelSources()
  const { tier, profile } = useHardwareTier()
  const resolved = useResolvedRecommendedModels(sources, tier, profile)
  const picks = useStaffPicks(sources, 'gguf', isVisionPick)
  const providers = useModelProvider((state) => state.providers)
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
  } = useDownloadStore()

  const installedIds = useMemo(() => {
    const local = providers.find((p) => p.provider === LOCAL_LLAMACPP_PROVIDER)
    return new Set(
      (local?.models ?? []).map((m: { id: string }) => m.id.toLowerCase())
    )
  }, [providers])

  const items = useMemo<VisionDownload[]>(() => {
    const candidates: Candidate[] = []
    for (const { rec, model } of resolved) {
      if (!model) continue
      candidates.push({
        repo: rec.modelName,
        title: prettyModelName(rec.modelName),
        hint: rec.descriptionKey,
        model,
        quantPin: rec.quant,
        mmprojPin: rec.mmprojQuant,
      })
    }
    for (const { pick, model } of picks) {
      if (!model) continue
      candidates.push({
        repo: pick.model_name,
        title: pick.title ?? prettyModelName(pick.model_name),
        hint: pick.description_key ?? 'hub:recVisionKnowledge',
        icon: pick.icon,
        model,
      })
    }

    const seenRepos = new Set<string>()
    const seenVariants = new Set<string>()
    const rows: Array<{ item: VisionDownload; rank: number; order: number }> =
      []
    candidates.forEach((candidate, order) => {
      const { model } = candidate
      const repoKey = candidate.repo.toLowerCase()
      if (seenRepos.has(repoKey)) return
      if (model.is_mlx) return
      // No projector, no vision: a text-only repo is out however it is tagged.
      const mmproj = pickProjector(model, candidate.mmprojPin)
      if (!mmproj) return
      const variant = pickVariant(model, candidate.quantPin)
      if (!variant) return
      const variantKey = variant.model_id.toLowerCase()
      if (seenVariants.has(variantKey)) return

      const weights = parseFileSizeToBytes(variant.file_size)
      const bytes =
        weights === undefined
          ? undefined
          : weights + (parseFileSizeToBytes(mmproj.file_size) ?? 0)
      const fit = judgeMemoryFit(bytes, profile)
      if (fit === 'wont_load') return

      seenRepos.add(repoKey)
      seenVariants.add(variantKey)
      const installed = installedIds.has(variantKey)
      const isDownloading =
        localDownloadingModels.has(variant.model_id) ||
        Object.values(downloads).some((d) => d.id === variant.model_id)
      rows.push({
        rank: installed ? -1 : fit === null ? 4 : FIT_RANK[fit],
        order,
        item: {
          repo: candidate.repo,
          title: candidate.title,
          hint: candidate.hint,
          icon: candidate.icon,
          sizeLabel: getTotalDownloadFileSize(model, variant, mmproj),
          model,
          variant,
          isDownloading,
          installed,
          start: () => {
            clearResumableDownload(variant.model_id)
            addLocalDownloadingModel(variant.model_id)
            serviceHub
              .models()
              .pullModelWithMetadata(
                variant.model_id,
                variant.path,
                mmproj.path,
                huggingfaceToken,
                true,
                resumableDownloads.has(variant.model_id)
              )
            return variant.model_id
          },
        },
      })
    })

    return rows
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, limit)
      .map((row) => row.item)
  }, [
    resolved,
    picks,
    profile,
    limit,
    installedIds,
    localDownloadingModels,
    downloads,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
    serviceHub,
    huggingfaceToken,
  ])

  // Nothing to show yet, though a card is still on its way.
  const pending =
    resolved.some((entry) => !entry.model) ||
    picks.some((entry) => !entry.model)
  const isLoading = items.length === 0 && pending

  return { items, isLoading }
}
