import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ONBOARDING_REMINDER_MODELS,
  SETUP_SCREEN_QUANTIZATIONS,
} from '@/constants/models'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useServiceHub } from '@/hooks/useServiceHub'
import { findPinnedQuant } from '@/lib/model-card'
import { getPreferredMmprojModel } from '@/lib/models'
import type { CatalogModel } from '@/services/models/types'

type Quant = NonNullable<CatalogModel['quants']>[number]

export type RecommendedLocalModel = {
  /** The tier's offer: repo, display title and any pinned quants. */
  reminder: (typeof ONBOARDING_REMINDER_MODELS)[keyof typeof ONBOARDING_REMINDER_MODELS]
  /** Resolved catalog card, or `null` while the fetch is in flight / failed. */
  model: CatalogModel | null
  /** The exact file a download would fetch. */
  variant: Quant | null
  isLoading: boolean
  /** True while this specific variant is downloading. */
  isDownloading: boolean
  /** Starts the download. Returns the model id started, or `null` if it could not. */
  startDownload: () => string | null
}

/**
 * The one local model we recommend to a user who has none, and the download
 * button behind it.
 *
 * Extracted from `PromptOnboardingModel` so the composer's "what do I reply
 * with?" widget offers the *same* model, resolved the same way, rather than a
 * second opinion that drifts from it. The two surfaces differ in when they
 * appear and what else they offer — not in which model they recommend.
 */
export function useRecommendedLocalModel(): RecommendedLocalModel {
  const serviceHub = useServiceHub()
  // A weak device must not be nudged toward the model the low-spec tier exists
  // to keep it away from.
  const { tier } = useHardwareTier()
  const reminder = ONBOARDING_REMINDER_MODELS[tier]
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
  } = useDownloadStore()
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const [model, setModel] = useState<CatalogModel | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const fetchAttempted = useRef(false)

  const fetchRecommendedModel = useCallback(async () => {
    if (fetchAttempted.current) return
    fetchAttempted.current = true

    try {
      const repo = await serviceHub
        .models()
        .fetchHuggingFaceRepo(reminder.repo, huggingfaceToken)

      if (repo) {
        setModel(serviceHub.models().convertHfRepoToCatalogModel(repo))
      }
    } catch (error) {
      console.error('Error fetching the recommended onboarding model:', error)
    } finally {
      setIsLoading(false)
    }
  }, [serviceHub, huggingfaceToken, reminder.repo])

  useEffect(() => {
    fetchRecommendedModel()
  }, [fetchRecommendedModel])

  const variant = useMemo(() => {
    if (!model) return null

    // The pin wins: this repo also ships a Q4_K_M that the loop below would
    // match, so without it the reminder downloads the wrong file silently.
    const pinned = findPinnedQuant(model.quants, reminder.quant)
    if (pinned) return pinned

    for (const quantization of SETUP_SCREEN_QUANTIZATIONS) {
      const found = model.quants?.find((quant) =>
        quant.model_id.toLowerCase().includes(quantization)
      )
      if (found) return found
    }

    return model.quants?.[0] ?? null
  }, [model, reminder.quant])

  const isDownloading = useMemo(() => {
    if (!variant) return false
    return (
      localDownloadingModels.has(variant.model_id) ||
      Object.values(downloads).some((d) => d.id === variant.model_id)
    )
  }, [variant, localDownloadingModels, downloads])

  const startDownload = useCallback((): string | null => {
    if (!variant || !model) return null

    clearResumableDownload(variant.model_id)
    addLocalDownloadingModel(variant.model_id)
    serviceHub
      .models()
      .pullModelWithMetadata(
        variant.model_id,
        variant.path,
        (findPinnedQuant(model.mmproj_models, reminder.mmprojQuant) ??
          getPreferredMmprojModel(model))?.path,
        huggingfaceToken,
        true,
        resumableDownloads.has(variant.model_id)
      )
    return variant.model_id
  }, [
    variant,
    model,
    reminder.mmprojQuant,
    huggingfaceToken,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
    serviceHub,
  ])

  return { reminder, model, variant, isLoading, isDownloading, startDownload }
}
