import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'

import { route } from '@/constants/routes'
import {
  ENGINE_UPDATE_ORDER,
  dismissEngineUpdate,
  engineUpdateOfferFrom,
  isEngineUpdateSnoozed,
  snoozeEngineUpdate,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import type { EngineVersions } from '@/services/engines/types'
import {
  engineUpdateTaskId,
  updateEngineWithProgress,
} from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/** First offer the core makes that the user has not put away, in banner order. */
function firstOffer(
  engines: Partial<Record<string, EngineVersions>>,
  hidden: ReadonlySet<string>,
  now = Date.now()
): EngineUpdateOffer | null {
  for (const engine of ENGINE_UPDATE_ORDER) {
    const versions = engines[engine]
    if (!versions) continue
    const offer = engineUpdateOfferFrom(versions)
    if (!offer || hidden.has(offer.targetBackend)) continue
    if (isEngineUpdateSnoozed(offer, now)) continue
    return offer
  }
  return null
}

export interface EngineUpdateState {
  /** The offer to show, or `null` when there is nothing to ask about. */
  offer: EngineUpdateOffer | null
  /** True from the moment "Update" is pressed until the core answers. */
  isApplying: boolean
  /**
   * "Update" — the core downloads the build and switches to it; a managed
   * engine's reinstall is confirmed on its own page instead.
   */
  applyUpdate: () => Promise<void>
  /** "Remind me later" — back in a day. */
  remindLater: () => void
  /** The × — this build is not coming back; a newer one still will. */
  dismiss: () => void
}

/**
 * The engine update offer on the shared banner, built from the core's answer
 * about every engine (`useEngineVersionsStore`, spec
 * `engine-lifecycle-desktop`). An accepted offer comes down at once: the
 * download panel shows the transfer, and the core's `engine:changed` refreshes
 * the answer once the new build is active. A refused update puts it back.
 */
export const useEngineUpdate = (): EngineUpdateState => {
  const navigate = useNavigate()
  const engines = useEngineVersionsStore((state) => state.engines)
  // Snoozing writes storage the selector cannot see; this re-reads it.
  const [answered, setAnswered] = useState(0)
  // Targets being applied now, and those applied this session: the answer
  // held still offers them until the core's `engine:changed` refreshes it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [applyingCount, setApplyingCount] = useState(0)

  const offer = useMemo(
    () => firstOffer(engines, hidden),
    // `answered` is the storage the snooze map lives in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engines, hidden, answered]
  )

  const applyUpdate = useCallback(async () => {
    if (!offer) return
    if (offer.apply === 'reinstall') {
      // A reinstall downloads a large image and asks for consent: the
      // engine's card confirms it first.
      await navigate({
        to: route.settings.providers,
        params: { providerName: offer.provider },
        search: { engineUpdate: true },
      })
      return
    }

    const target = offer.targetBackend
    setHidden((held) => new Set(held).add(target))
    setApplyingCount((n) => n + 1)
    try {
      if (offer.provider === 'sd-cpp') {
        // The image store keeps Settings → Media's view of the update and
        // installs what it has seen offered: let it read this offer first.
        const images = useImageGenerationStore.getState()
        if (images.engineUpdate.availableTag !== offer.targetVersion) {
          await images.checkEngineUpdate()
        }
        if (!useImageGenerationStore.getState().engineUpdate.availableTag) {
          throw new Error('The media engine has no update to install.')
        }
        await useImageGenerationStore.getState().updateEngine()
      } else {
        await updateEngineWithProgress(offer.provider, {
          taskId: engineUpdateTaskId(offer.provider, offer.targetVersion),
          backend: offer.targetBackend,
        })
      }
    } catch (error) {
      // Refused: the offer is still true, so it comes back.
      setHidden((held) => {
        const next = new Set(held)
        next.delete(target)
        return next
      })
      throw error
    } finally {
      setApplyingCount((n) => n - 1)
    }
  }, [offer, navigate])

  const remindLater = useCallback(() => {
    if (!offer) return
    snoozeEngineUpdate(offer)
    setAnswered((n) => n + 1)
  }, [offer])

  const dismiss = useCallback(() => {
    if (!offer) return
    dismissEngineUpdate(offer)
    setAnswered((n) => n + 1)
  }, [offer])

  return {
    offer,
    isApplying: applyingCount > 0,
    applyUpdate,
    remindLater,
    dismiss,
  }
}
