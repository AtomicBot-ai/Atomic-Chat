/**
 * The ChatGPT subscription connection, as the Cloud page sees it.
 *
 * No token ever reaches this layer — `chatgptStatus` returns a label and an
 * expiry, and the backend refreshes on its own. `connect()` is a single
 * long-running call that resolves when the browser callback has been exchanged,
 * so there is no polling and no half-connected state to reconcile.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { ModelCapabilities } from '@/types/models'
import type { ChatGptModel, ChatGptStatus } from '@/services/auth/types'

/** The provider id the subscription is registered under. */
const CHATGPT_PROVIDER = 'chatgpt'

/**
 * Put the subscription's models on the provider while it is signed in, and take
 * them away when it is not.
 *
 * This is what makes the model picker honest — a model is only listed while a
 * request for it can actually be served — and it is what `hasValidProviders`
 * reads as "this subscription is connected", since there is no API key to look
 * at. Written through the store rather than the service because the provider
 * list is what every consumer reads.
 */
function syncSubscriptionModels(models: ChatGptModel[]): void {
  // Guarded: the model list is a consequence of the sign-in, not part of it.
  // A store that cannot be written must not leave the card stuck showing the
  // previous state.
  try {
    const store = useModelProvider.getState()
    if (!store.getProviderByName(CHATGPT_PROVIDER)) return
    store.updateProvider(CHATGPT_PROVIDER, {
      models: models.map((model) => ({
        id: model.id,
        model: model.id,
        name: model.display_name || model.id,
        capabilities: [
          ModelCapabilities.COMPLETION,
          ModelCapabilities.TOOLS,
          ...(model.vision ? [ModelCapabilities.VISION] : []),
        ],
        version: '1.0',
      })),
    })
  } catch (error) {
    console.warn('[chatgpt-auth] could not sync subscription models:', error)
  }
}

export type ChatGptConnectionState =
  | 'unavailable'
  | 'loading'
  | 'disconnected'
  | 'connecting'
  | 'connected'

export type UseChatGptAuth = {
  state: ChatGptConnectionState
  /** How many models the connection puts in the picker. */
  modelCount: number
  /** `you@example.test (Plus)` once connected, otherwise undefined. */
  account?: string
  error?: string
  connect: () => Promise<void>
  cancel: () => Promise<void>
  disconnect: () => Promise<void>
}

function formatAccount(status: ChatGptStatus): string | undefined {
  if (!status.connected) return undefined
  const email = status.email?.trim()
  const plan = status.plan_type?.trim()
  if (email && plan) return `${email} (${plan})`
  return email || plan || undefined
}

export function useChatGptAuth(): UseChatGptAuth {
  const serviceHub = useServiceHub()
  const supported = PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION]

  const [status, setStatus] = useState<ChatGptStatus | null>(null)
  const [models, setModels] = useState<ChatGptModel[]>([])
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // A sign-in can outlive this component (the user goes to the browser and
  // back); don't write state into an unmounted tree.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Pull the account's own catalogue and put it on the provider, or take the
   * models away when disconnected.
   *
   * Fetched rather than curated: a hardcoded list offers models the account may
   * not carry, and every send then fails with nothing to act on. A catalogue we
   * cannot reach leaves the models off for the same reason.
   */
  const applyModels = useCallback(
    async (connected: boolean) => {
      if (!connected) {
        setModels([])
        syncSubscriptionModels([])
        return
      }
      try {
        const catalogue = await serviceHub.auth().chatgptModels()
        const offered = catalogue.filter((model) => model.listed)
        if (mounted.current) setModels(offered)
        syncSubscriptionModels(offered)
      } catch (err) {
        console.warn('[chatgpt-auth] could not list subscription models:', err)
        syncSubscriptionModels([])
      }
    },
    [serviceHub]
  )

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void serviceHub
      .auth()
      .chatgptStatus()
      .then(async (next) => {
        if (cancelled) return
        setStatus(next)
        await applyModels(next.connected)
      })
      .catch((err) => {
        console.warn('[chatgpt-auth] status read failed:', err)
        if (!cancelled) setStatus({ connected: false })
      })
    return () => {
      cancelled = true
    }
  }, [applyModels, serviceHub, supported])

  const connect = useCallback(async () => {
    setError(undefined)
    setConnecting(true)
    try {
      const next = await serviceHub.auth().chatgptLogin()
      await applyModels(next.connected)
      if (mounted.current) setStatus(next)
    } catch (err) {
      // The backend's message is the actionable one (port busy, cancelled,
      // rejected by the provider) — surface it rather than a generic failure.
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }, [applyModels, serviceHub])

  const cancel = useCallback(async () => {
    try {
      await serviceHub.auth().chatgptCancelLogin()
    } catch (err) {
      console.warn('[chatgpt-auth] cancel failed:', err)
    }
  }, [serviceHub])

  const disconnect = useCallback(async () => {
    setError(undefined)
    try {
      const next = await serviceHub.auth().chatgptLogout()
      await applyModels(false)
      if (mounted.current) setStatus(next)
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyModels, serviceHub])

  const state: ChatGptConnectionState = !supported
    ? 'unavailable'
    : connecting
      ? 'connecting'
      : status === null
        ? 'loading'
        : status.connected
          ? 'connected'
          : 'disconnected'

  return {
    state,
    modelCount: models.length,
    account: status ? formatAccount(status) : undefined,
    error,
    connect,
    cancel,
    disconnect,
  }
}
