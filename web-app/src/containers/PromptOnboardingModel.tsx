import { Button } from '@/components/ui/button'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useOnboardingModelReminder } from '@/hooks/useOnboardingModelReminder'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogModel } from '@/services/models/types'
import {
  ONBOARDING_REMINDER_MODELS,
  SETUP_SCREEN_QUANTIZATIONS,
} from '@/constants/models'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { findPinnedQuant } from '@/lib/model-card'
import { getPreferredMmprojModel } from '@/lib/models'
import { HUGGINGFACE_LOGO_SRC, modelFamilyLogoSrc } from '@/lib/model-logo'
import { captureOnboardingModelReminder } from '@/lib/onboarding-telemetry'

// The offer is about the model, not the app, so it carries the model's brand
// mark. Derived from the repo id so it follows the recommendation.
const reminderModelLogoSrc = (repo: string) =>
  modelFamilyLogoSrc(repo) ?? HUGGINGFACE_LOGO_SRC

/// Bottom-right offer shown once onboarding has been left without a model,
/// either by Skip or by the auto-exit timeout. Repeats the first onboarding
/// recommendation so the user can still get a local model in one click.
export function PromptOnboardingModel() {
  const { setPending } = useOnboardingModelReminder()
  const serviceHub = useServiceHub()
  // A weak device that skipped onboarding must not be nudged toward the model
  // the low-spec tier exists to keep it away from.
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

  const [recommendedModel, setRecommendedModel] = useState<CatalogModel | null>(
    null
  )
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
        setRecommendedModel(
          serviceHub.models().convertHfRepoToCatalogModel(repo)
        )
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

  const defaultVariant = useMemo(() => {
    if (!recommendedModel) return null

    // The pin wins: this repo also ships a Q4_K_M that the loop below would
    // match, so without it the reminder downloads the wrong file silently.
    const pinned = findPinnedQuant(recommendedModel.quants, reminder.quant)
    if (pinned) return pinned

    for (const quantization of SETUP_SCREEN_QUANTIZATIONS) {
      const variant = recommendedModel.quants?.find((quant) =>
        quant.model_id.toLowerCase().includes(quantization)
      )
      if (variant) return variant
    }

    return recommendedModel.quants?.[0]
  }, [recommendedModel, reminder.quant])

  const isDownloading = useMemo(() => {
    if (!defaultVariant) return false
    return (
      localDownloadingModels.has(defaultVariant.model_id) ||
      Object.values(downloads).some((d) => d.id === defaultVariant.model_id)
    )
  }, [defaultVariant, localDownloadingModels, downloads])

  // Impression, fired once the card is actually on screen. The ref guard keeps
  // StrictMode's double-mount from counting it twice.
  const shownFiredRef = useRef(false)
  useEffect(() => {
    if (isLoading || shownFiredRef.current) return
    shownFiredRef.current = true
    captureOnboardingModelReminder('shown')
  }, [isLoading])

  const handleDismiss = () => {
    captureOnboardingModelReminder('later')
    setPending(false)
  }

  const handleDownload = () => {
    if (!defaultVariant || !recommendedModel) return
    captureOnboardingModelReminder('download')

    clearResumableDownload(defaultVariant.model_id)
    addLocalDownloadingModel(defaultVariant.model_id)
    serviceHub
      .models()
      .pullModelWithMetadata(
        defaultVariant.model_id,
        defaultVariant.path,
        (findPinnedQuant(
          recommendedModel.mmproj_models,
          reminder.mmprojQuant
        ) ?? getPreferredMmprojModel(recommendedModel))?.path,
        huggingfaceToken,
        true,
        resumableDownloads.has(defaultVariant.model_id)
      )
    setPending(false)
  }

  if (isLoading) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 p-4 shadow-lg bg-background w-4/5 md:w-100 border rounded-lg">
      <div className="flex items-center gap-2">
        <img
          src={reminderModelLogoSrc(reminder.repo)}
          alt=""
          className="size-5 shrink-0 object-contain"
          aria-hidden
        />
        <h2 className="font-medium">
          {reminder.title}
          {defaultVariant && (
            <span className="text-muted-foreground">
              {' '}
              ({defaultVariant.file_size})
            </span>
          )}
        </h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Get started with {reminder.title}, our recommended local model for your
        device.
      </p>
      <div className="mt-4 flex justify-end space-x-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={handleDismiss}
        >
          Later
        </Button>
        <Button
          onClick={handleDownload}
          disabled={!defaultVariant || isDownloading}
          size="sm"
        >
          {isDownloading ? 'Downloading' : 'Download'}
        </Button>
      </div>
    </div>
  )
}
