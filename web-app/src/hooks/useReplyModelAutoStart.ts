import { useCallback, useMemo } from 'react'

import type { ReplyModelGateResolution } from '@/containers/ReplyModelGate'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { captureReplyModelAutoResolved } from '@/lib/reply-gate-telemetry'
import {
  pickReplyModel,
  replyGateContext,
  type LastUsedModel,
  type ReplyModelOption,
  type ReplyResolution,
} from '@/lib/reply-model-gate'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { switchToModel } from '@/utils/switchModel'

/**
 * Answer a send with nothing selected by starting a model, not by asking.
 *
 * `preloadModelOnStartup` is off by default, so "nothing selected" is the
 * state of every cold launch — including on a machine with a perfectly good
 * model on disk. The user typing a message and pressing Send is the intent;
 * routing them through a widget to confirm what the device already knows is
 * a question with one answer (ATO-461).
 *
 * The chain is `resolveReplyModel`: last used → connected cloud → the most
 * compact local model on upstream llama.cpp, or on MLX when llama.cpp holds
 * none.
 * When it finds something, this selects it, starts it, and hands the composer
 * a resolution to queue the message on. Only a device with nothing at all
 * returns `null`, and the composer opens the widget to offer a download.
 *
 * A local model is started here, on the send, and never at launch: that is
 * the line the product drew — a local model costs memory, and only an
 * expressed intent to chat should pay it.
 *
 * The pick is {@link pickReplyModel}, the same function
 * {@link useReplyModelPreview} reads, so what the Send button says it will
 * start is what this starts.
 */
export function useReplyModelAutoStart(): {
  tryAutoStart: () => ReplyModelGateResolution | null
} {
  const serviceHub = useServiceHub()
  const { tier } = useHardwareTier()

  const tryAutoStart = useCallback((): ReplyModelGateResolution | null => {
    const { providers, selectModelProvider } = useModelProvider.getState()
    const resolved = pickReplyModel(providers, getLastUsedModel())
    if (!resolved) return null

    const { option, resolution } = resolved
    const context = replyGateContext(providers)
    captureReplyModelAutoResolved({
      resolution,
      localModelCount: context.localModelCount,
      cloudProviderCount: context.cloudProviderCount,
      hasCloudConnection: context.hasCloudConnection,
      hardwareTier: tier,
    })

    // Selected up front so the composer and the model dropdown reflect the
    // choice at once; the switch below is what actually brings it up.
    selectModelProvider(option.providerName, option.modelId)
    void switchToModel({
      modelId: option.modelId,
      providerName: option.providerName,
      serviceHub,
    }).catch((error) => {
      console.error('[useReplyModelAutoStart] failed to start model', error)
    })

    const now = Date.now()
    return {
      outcome: 'auto_start',
      branch: 'auto_start',
      decidedInMs: 0,
      openedAtMs: now,
      resolution,
      modelLabel: option.label,
    }
  }, [serviceHub, tier])

  return { tryAutoStart }
}

/**
 * What `tryAutoStart` would start if Send were pressed now — without starting,
 * selecting or reporting anything.
 *
 * The Send button with nothing selected used to be labelled "Choose what to
 * reply with" and then, on click, load the last used model and send: a
 * control named as a choice that sent the message (AC-02). It now names the
 * model it is about to load ("Send with Qwen3.5 4B"), and keeps the choice
 * label only when nothing resolves — that click really does open the widget.
 *
 * Follows the provider store and the last-used pointer, so a model that
 * finishes downloading or a cloud key that gets connected relabels the
 * button. `enabled: false` skips the work while a model is selected.
 */
export function useReplyModelPreview(
  enabled = true
): { option: ReplyModelOption; resolution: ReplyResolution } | null {
  const providers = useModelProvider((state) => state.providers)
  // Read on every render (a localStorage read), memoized on its value: the
  // pointer is written by model switches, which re-render the composer.
  const lastUsedKey = enabled ? JSON.stringify(getLastUsedModel()) : 'null'
  return useMemo(() => {
    if (!enabled) return null
    const lastUsed = JSON.parse(lastUsedKey) as LastUsedModel
    return pickReplyModel(providers, lastUsed)
  }, [enabled, providers, lastUsedKey])
}
