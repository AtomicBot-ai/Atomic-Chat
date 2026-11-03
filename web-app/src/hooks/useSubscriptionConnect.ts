import { useEffect, useRef } from 'react'

import { useChatGptAuth } from '@/hooks/useChatGptAuth'
import { useModelProvider } from '@/hooks/useModelProvider'
import { captureSubscriptionCardShown } from '@/lib/subscription-telemetry'

/** What a subscription sign-in leaves for the caller to select. */
export type SubscriptionConnectResult = {
  providerName: string
  modelId: string | null
}

/**
 * Signing in to a subscription provider from a setup surface: the Add
 * provider dialog and the first-run cloud step. Reports the sign-in card's
 * impression and calls `onConnected` once, when the account is connected.
 *
 * Mount it only when the user asks for this provider: `useChatGptAuth` asks
 * the backend for the connection status as soon as it mounts.
 */
export function useSubscriptionConnect(
  provider: ModelProvider,
  onConnected: (result: SubscriptionConnectResult) => void
) {
  // Both setup surfaces count as onboarding for ATO-456, which is about
  // knowing whether people sign in from setup or from the Cloud page.
  const auth = useChatGptAuth('onboarding')
  const { state } = auth

  // These surfaces render their own UI rather than `CloudSubscriptionCard`, so
  // the impression has to be emitted here or the onboarding surface would
  // have a conversion rate with no denominator.
  useEffect(() => {
    captureSubscriptionCardShown({
      provider: provider.provider,
      surface: 'onboarding',
    })
  }, [provider.provider])

  // Held in a ref so the effect below depends on the connection state alone.
  // The callback is rebuilt on every parent render, and re-running the exit for
  // that would navigate out of onboarding twice.
  const onConnectedRef = useRef(onConnected)
  useEffect(() => {
    onConnectedRef.current = onConnected
  }, [onConnected])
  const finished = useRef(false)

  // Driven off the state rather than off `connect()` resolving: a session
  // signed in before onboarding started reports `connected` on the first status
  // read, and that user has as little left to do as the one who just signed in.
  useEffect(() => {
    if (state !== 'connected' || finished.current) return
    finished.current = true
    // The sign-in writes the account's catalogue onto the provider before it
    // reports connected, so the current model list is the store's — not the
    // `provider` object this step was opened with.
    const models = useModelProvider
      .getState()
      .getProviderByName(provider.provider)?.models
    onConnectedRef.current({
      providerName: provider.provider,
      modelId: models?.[0]?.id ?? null,
    })
  }, [provider.provider, state])

  return { ...auth, connecting: state === 'connecting' }
}
