import { useCallback, useMemo } from 'react'

import { SETUP_SCREEN_QUANTIZATIONS } from '@/constants/models'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelSources } from '@/hooks/useModelSources'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findPinnedQuant } from '@/lib/model-card'
import { prettyModelName } from '@/lib/model-display-name'
import { getPreferredMmprojModel } from '@/lib/models'
import type { CatalogModel, ModelQuant } from '@/services/models/types'

export type RecommendedDownload = {
  /** Hugging Face repo id, e.g. `AtomicChat/Qwen3.5-4B-GGUF`. */
  repo: string
  title: string
  /** i18n key for the one-line reason, from the manifest. */
  descriptionKey: string
  /** Resolved catalog card. */
  model: CatalogModel
  /** The exact file a download would fetch. */
  variant: ModelQuant
  isDownloading: boolean
  /** Starts the download. Returns the model id started, or `null` if it could not. */
  start: () => string | null
}

/**
 * The local models recommended for this machine, best fit first, each with
 * the download behind it.
 *
 * The same list onboarding leads with — the manifest's rung for this tier,
 * stepped down until it fits, with the bundled ladder as the fallback — so the
 * composer's "what do I reply with?" widget never offers a second opinion.
 * GGUF only: it is the format every platform runs, and the one both surfaces
 * open on; MLX twins stay behind the Hub's format filter.
 */
export function useRecommendedDownloads(limit = 3): {
  items: RecommendedDownload[]
  isLoading: boolean
} {
  const serviceHub = useServiceHub()
  const { sources } = useModelSources()
  const { tier, profile } = useHardwareTier()
  const resolved = useResolvedRecommendedModels(sources, tier, profile)
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
  } = useDownloadStore()

  const pickVariant = useCallback(
    (model: CatalogModel, quant?: string): ModelQuant | null => {
      // The pin wins: a repo can ship a Q4_K_M that the loop below would match
      // too, and without the pin the download takes the wrong file silently.
      const pinned = findPinnedQuant(model.quants, quant)
      if (pinned) return pinned
      for (const quantization of SETUP_SCREEN_QUANTIZATIONS) {
        const found = model.quants?.find((q) =>
          q.model_id.toLowerCase().includes(quantization)
        )
        if (found) return found
      }
      return model.quants?.[0] ?? null
    },
    []
  )

  // Only rows whose card has resolved: a row that cannot be downloaded yet is
  // a spinner with a disabled button, and two of those in a row read as a
  // broken list. Order is kept, so the lead stays the lead once it resolves.
  const items = useMemo<RecommendedDownload[]>(() => {
    const out: RecommendedDownload[] = []
    const seen = new Set<string>()
    for (const { rec, model } of resolved) {
      if (out.length >= limit) break
      if (!model || model.is_mlx) continue
      const variant = pickVariant(model, rec.quant)
      if (!variant) continue
      const key = variant.model_id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const isDownloading =
        localDownloadingModels.has(variant.model_id) ||
        Object.values(downloads).some((d) => d.id === variant.model_id)
      out.push({
        repo: rec.modelName,
        title: prettyModelName(rec.modelName),
        descriptionKey: rec.descriptionKey,
        model,
        variant,
        isDownloading,
        start: () => {
          clearResumableDownload(variant.model_id)
          addLocalDownloadingModel(variant.model_id)
          serviceHub
            .models()
            .pullModelWithMetadata(
              variant.model_id,
              variant.path,
              (
                findPinnedQuant(model.mmproj_models, rec.mmprojQuant) ??
                getPreferredMmprojModel(model)
              )?.path,
              huggingfaceToken,
              true,
              resumableDownloads.has(variant.model_id)
            )
          return variant.model_id
        },
      })
    }
    return out
  }, [
    resolved,
    limit,
    pickVariant,
    localDownloadingModels,
    downloads,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
    serviceHub,
    huggingfaceToken,
  ])

  // Nothing resolved yet, though there is something to resolve.
  const isLoading = items.length === 0 && resolved.length > 0

  return { items, isLoading }
}
