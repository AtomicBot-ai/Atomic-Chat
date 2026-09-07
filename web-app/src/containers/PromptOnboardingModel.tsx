import { Button } from '@/components/ui/button'
import { useOnboardingModelReminder } from '@/hooks/useOnboardingModelReminder'
import { useRecommendedLocalModel } from '@/hooks/useRecommendedLocalModel'
import { useEffect, useRef } from 'react'
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
  const {
    reminder,
    variant: defaultVariant,
    isLoading,
    isDownloading,
    startDownload,
  } = useRecommendedLocalModel()

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
    if (!startDownload()) return
    captureOnboardingModelReminder('download')
    setPending(false)
  }

  if (isLoading) return null

  return (
    <div className="fixed bottom-[calc(1rem+var(--download-panel-offset,0px))] right-4 z-50 p-4 shadow-lg bg-background w-4/5 md:w-100 border rounded-lg transition-[bottom] duration-200">
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
