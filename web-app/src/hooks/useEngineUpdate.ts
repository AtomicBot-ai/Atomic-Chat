import { useCallback, useEffect, useState } from 'react'

import { MEDIA_ENGINE_PROVIDER } from '@/lib/diffusion/engineUpdateOffer'
import {
  clearEngineUpdateOffer,
  dismissEngineUpdate,
  isEngineUpdateSnoozed,
  readEngineUpdateOffer,
  snoozeEngineUpdate,
  ENGINE_UPDATE_AVAILABLE_EVENT,
  ENGINE_UPDATE_RETRACTED_EVENT,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import { ExtensionManager } from '@/lib/extension'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'

interface BackendDownloadCapableExtension {
  downloadRecommendedBackend?(backendString: string): Promise<void>
}

/** "Update" for an engine an extension owns: the extension downloads it. */
const throughExtension =
  (extensionName: string) =>
  async (offer: EngineUpdateOffer): Promise<void> => {
    const extension = ExtensionManager.getInstance().getByName(
      extensionName
    ) as BackendDownloadCapableExtension | undefined

    if (!extension?.downloadRecommendedBackend) {
      throw new Error(`${extensionName} cannot download a backend on request`)
    }

    // The transfer takes minutes and reports through the backend download
    // events that `<BackendUpdater />` already renders, so this is awaited
    // only far enough to know it started.
    await extension.downloadRecommendedBackend(offer.targetBackend)
  }

/**
 * "Update" for the media engine, which no extension owns: the image store
 * installs it. The offer may be one an earlier launch persisted, read before
 * this launch's check answered — the store then looks again first, and a
 * manifest that no longer names a newer build leaves nothing to do.
 */
const throughImageStore = async (offer: EngineUpdateOffer): Promise<void> => {
  if (
    useImageGenerationStore.getState().engineUpdate.availableTag !==
    offer.targetVersion
  ) {
    await useImageGenerationStore.getState().checkEngineUpdate()
  }
  const { engineUpdate, updateEngine } = useImageGenerationStore.getState()
  if (!engineUpdate.availableTag) return
  // Not awaited: `<BackendUpdater />` shows the download and its outcome.
  void updateEngine()
}

/**
 * Providers that can offer an engine update, most-preferred first, each with
 * what "Update" does for it. The llama.cpp providers ship side by side, and
 * only one banner may be on screen — the default provider's offer wins, the
 * others wait until the first is dealt with. The media engine comes last: a
 * chat engine is what most sessions use.
 *
 * MLX is deliberately absent: its sidecar ships inside the app bundle and has
 * no independent release stream to compare against, so there is nothing to
 * offer until one exists. Adding it is a matter of publishing an offer from
 * `mlx-extension` — nothing in this hook or the banner is llama.cpp-specific.
 */
const ENGINE_PROVIDERS: {
  provider: string
  apply: (offer: EngineUpdateOffer) => Promise<void>
}[] = [
  {
    provider: LOCAL_LLAMACPP_PROVIDER,
    apply: throughExtension('@janhq/llamacpp-upstream-extension'),
  },
  {
    provider: 'llamacpp',
    apply: throughExtension('@janhq/llamacpp-extension'),
  },
  {
    provider: 'atomic-prism',
    apply: throughExtension('@janhq/atomic-prism-extension'),
  },
  { provider: MEDIA_ENGINE_PROVIDER, apply: throughImageStore },
]

/** First non-snoozed, still-meaningful offer across the engine providers. */
function readActiveOffer(now = Date.now()): EngineUpdateOffer | null {
  for (const { provider } of ENGINE_PROVIDERS) {
    const offer = readEngineUpdateOffer(provider)
    if (!offer) continue
    // An offer that survived the backend already moving to its target is
    // stale. The extension clears it on hot-swap, but a restart-required
    // fallback or a manual switch in settings leaves it behind.
    if (offer.targetBackend === offer.currentBackend) {
      clearEngineUpdateOffer(provider)
      continue
    }
    if (isEngineUpdateSnoozed(offer, now)) continue
    return offer
  }
  return null
}

export interface EngineUpdateState {
  /** The offer to show, or `null` when there is nothing to ask about. */
  offer: EngineUpdateOffer | null
  /** True from the moment "Update" is pressed until the transfer starts. */
  isApplying: boolean
  /** "Update" — download the build and hot-swap onto it. */
  applyUpdate: () => Promise<void>
  /** "Remind me later" — back in a day. */
  remindLater: () => void
  /** The × — this build is not coming back; a newer one still will. */
  dismiss: () => void
}

/**
 * Surfaces the engine update offer published by the llama.cpp extensions
 * (ATO-528 / ATO-531) and by the image-generation store for the media engine.
 *
 * Two sources, for the same reason the better-backend recommendation has two:
 * the extension's release-tag reconciliation can finish either side of React
 * mounting, so the banner reads the persisted offer once on mount *and*
 * listens for the event.
 */
export const useEngineUpdate = (): EngineUpdateState => {
  const [offer, setOffer] = useState<EngineUpdateOffer | null>(null)
  const [isApplying, setIsApplying] = useState(false)

  useEffect(() => {
    setOffer(readActiveOffer())

    const handleOffer = (event: Event) => {
      const detail = (event as CustomEvent<EngineUpdateOffer>).detail
      if (!detail?.targetBackend) return
      // Re-read rather than trusting the event: another provider may hold a
      // higher-priority offer, and this one may already be snoozed.
      setOffer(readActiveOffer())
    }
    // The withdrawn offer is already off disk; whatever is left takes over.
    const handleRetracted = () => setOffer(readActiveOffer())

    window.addEventListener(ENGINE_UPDATE_AVAILABLE_EVENT, handleOffer)
    window.addEventListener(ENGINE_UPDATE_RETRACTED_EVENT, handleRetracted)
    return () => {
      window.removeEventListener(ENGINE_UPDATE_AVAILABLE_EVENT, handleOffer)
      window.removeEventListener(
        ENGINE_UPDATE_RETRACTED_EVENT,
        handleRetracted
      )
    }
  }, [])

  const applyUpdate = useCallback(async () => {
    if (!offer || isApplying) return
    const entry = ENGINE_PROVIDERS.find((e) => e.provider === offer.provider)
    if (!entry) return

    setIsApplying(true)
    try {
      // The banner comes down once the update is under way; a failure leaves
      // the offer in place for the next launch.
      await entry.apply(offer)
      clearEngineUpdateOffer(offer.provider)
      setOffer(null)
    } catch (error) {
      console.error('Engine update failed to start:', error)
      throw error
    } finally {
      setIsApplying(false)
    }
  }, [offer, isApplying])

  const remindLater = useCallback(() => {
    if (!offer) return
    snoozeEngineUpdate(offer)
    setOffer(readActiveOffer())
  }, [offer])

  const dismiss = useCallback(() => {
    if (!offer) return
    dismissEngineUpdate(offer)
    setOffer(readActiveOffer())
  }, [offer])

  return { offer, isApplying, applyUpdate, remindLater, dismiss }
}
