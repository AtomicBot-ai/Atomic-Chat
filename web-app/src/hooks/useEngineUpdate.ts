import { useCallback, useEffect, useState } from 'react'

import {
  clearEngineUpdateOffer,
  dismissEngineUpdate,
  isEngineUpdateSnoozed,
  readEngineUpdateOffer,
  snoozeEngineUpdate,
  ENGINE_UPDATE_AVAILABLE_EVENT,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import { ExtensionManager } from '@/lib/extension'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

/**
 * Providers that can offer an engine update, most-preferred first. Both
 * llama.cpp providers ship side by side on Windows/Linux, and only one banner
 * may be on screen — the default provider's offer wins, the other one waits
 * until the first is dealt with.
 *
 * MLX is deliberately absent: its sidecar ships inside the app bundle and has
 * no independent release stream to compare against, so there is nothing to
 * offer until one exists. Adding it is a matter of publishing an offer from
 * `mlx-extension` — nothing in this hook or the banner is llama.cpp-specific.
 */
const ENGINE_PROVIDERS: { provider: string; extensionName: string }[] = [
  {
    provider: LOCAL_LLAMACPP_PROVIDER,
    extensionName: '@janhq/llamacpp-upstream-extension',
  },
  { provider: 'llamacpp', extensionName: '@janhq/llamacpp-extension' },
]

interface BackendDownloadCapableExtension {
  downloadRecommendedBackend?(backendString: string): Promise<void>
}

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
 * Surfaces the inference-engine update offer published by the llama.cpp
 * extensions (ATO-528 / ATO-531).
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

    window.addEventListener(ENGINE_UPDATE_AVAILABLE_EVENT, handleOffer)
    return () => {
      window.removeEventListener(ENGINE_UPDATE_AVAILABLE_EVENT, handleOffer)
    }
  }, [])

  const applyUpdate = useCallback(async () => {
    if (!offer || isApplying) return
    const entry = ENGINE_PROVIDERS.find((e) => e.provider === offer.provider)
    if (!entry) return

    setIsApplying(true)
    try {
      const extension = ExtensionManager.getInstance().getByName(
        entry.extensionName
      ) as BackendDownloadCapableExtension | undefined

      if (!extension?.downloadRecommendedBackend) {
        throw new Error(
          `${entry.extensionName} cannot download a backend on request`
        )
      }

      // The transfer takes minutes and reports through the backend download
      // events that `<BackendUpdater />` already renders, so this is awaited
      // only far enough to know it started. The banner comes down either way:
      // a failure leaves the offer in place for the next launch.
      await extension.downloadRecommendedBackend(offer.targetBackend)
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
