import { Button } from '@/components/ui/button'
import { useOnboardingModelReminder } from '@/hooks/useOnboardingModelReminder'
import { useRecommendedDownloads } from '@/hooks/useRecommendedDownloads'
import { useEffect, useRef, useState } from 'react'
import { HUGGINGFACE_LOGO_SRC, modelFamilyLogoSrc } from '@/lib/model-logo'
import { captureOnboardingModelReminder } from '@/lib/onboarding-telemetry'

// The offer is about the model, not the app, so it carries the model's brand
// mark. Derived from the repo id so it follows the recommendation.
const reminderModelLogoSrc = (repo: string) =>
  modelFamilyLogoSrc(repo) ?? HUGGINGFACE_LOGO_SRC

/** How long the recommendation may take to resolve before the card stops
 *  waiting. Same budget as the composer's widget (`ReplyModelGate`). */
const RECOMMENDATION_WAIT_MS = 8_000

/// Bottom-right offer shown once onboarding has been left without a model,
/// either by Skip or by the auto-exit timeout. Repeats the first onboarding
/// recommendation — the manifest's best fit for this machine, the same one the
/// composer's widget leads with — so the user can still get a local model in
/// one click.
export function PromptOnboardingModel() {
  const { setPending } = useOnboardingModelReminder()
  const { items, isLoading } = useRecommendedDownloads(1)
  const offer = items[0]

  // The card lookup has no failure state of its own, so a lead that never
  // resolves would keep this component waiting for the rest of the session.
  // Past the budget it stops: a card surfacing minutes later would be a
  // surprise, and the reminder stays armed for the next launch's fresh try.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!isLoading || gaveUp) return
    const timer = setTimeout(() => setGaveUp(true), RECOMMENDATION_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading, gaveUp])

  const visible = Boolean(offer) && !gaveUp

  // Impression, fired once the card is actually on screen. The ref guard keeps
  // StrictMode's double-mount from counting it twice.
  const shownFiredRef = useRef(false)
  useEffect(() => {
    if (!visible || shownFiredRef.current) return
    shownFiredRef.current = true
    captureOnboardingModelReminder('shown')
  }, [visible])

  if (!visible) return null

  const handleDismiss = () => {
    captureOnboardingModelReminder('later')
    setPending(false)
  }

  const handleDownload = () => {
    if (!offer.start()) return
    captureOnboardingModelReminder('download')
    setPending(false)
  }

  return (
    <div className="fixed bottom-[calc(1rem+var(--download-panel-offset,0px))] right-4 z-50 p-4 shadow-lg bg-background w-4/5 md:w-100 border rounded-lg transition-[bottom] duration-200">
      <div className="flex items-center gap-2">
        <img
          src={reminderModelLogoSrc(offer.repo)}
          alt=""
          className="size-5 shrink-0 object-contain"
          aria-hidden
        />
        <h2 className="font-medium">
          {offer.title}
          <span className="text-muted-foreground">
            {' '}
            ({offer.variant.file_size})
          </span>
        </h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Get started with {offer.title}, our recommended local model for your
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
          disabled={offer.isDownloading}
          size="sm"
        >
          {offer.isDownloading ? 'Downloading' : 'Download'}
        </Button>
      </div>
    </div>
  )
}
