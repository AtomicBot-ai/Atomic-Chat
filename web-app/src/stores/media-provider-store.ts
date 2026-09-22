/**
 * The configured media providers, their live health, and their capabilities.
 *
 * Mirrors `provider-registry-store` in shape and intent: a Zustand store that
 * both React and non-React callers can read, seeded from a bundled baseline.
 *
 * What is persisted and what is not is deliberate:
 *  - Persisted: the descriptors and the selected model. These are the user's
 *    configuration.
 *  - NOT persisted: health, capabilities and errors. They describe the world
 *    right now. Restoring yesterday's "online" would render a confident lie
 *    about a worker that is not running.
 *
 * Secrets never live here. A descriptor may carry `auth.setting_key` naming
 * where a credential is kept, but the credential itself is never read into or
 * written out of this store.
 *
 * See `web-app/src/services/AGENTS.md` for feature-level guidance.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import {
  BASELINE_MEDIA_PROVIDERS,
  RETIRED_BUILTIN_PROVIDER_IDS,
} from '@/constants/mediaProviders'
import { createMediaAdapter } from '@/services/media/providerFactory'
import { getMediaProvidersOrFallback } from '@/services/media-registry'
import type {
  MediaCapabilities,
  MediaModelDescriptor,
  MediaProviderDescriptor,
  MediaProviderHealth,
} from '@/services/media/contract'

/** How long a single provider gets to answer before the refresh gives up. */
const DEFAULT_REFRESH_TIMEOUT_MS = 8000

export type MediaRefreshOptions = {
  timeoutMs?: number
  /** Refresh only this provider. Defaults to every enabled provider. */
  providerId?: string
}

type MediaProviderState = {
  providers: MediaProviderDescriptor[]
  health: Record<string, MediaProviderHealth>
  capabilities: Record<string, MediaCapabilities>
  /** Per-provider failure text, or null when that provider last succeeded. */
  errors: Record<string, string | null>
  selectedModelId: string | null
  refreshing: boolean

  /** Last remote-registry outcome. Never persisted; re-derived per launch. */
  registrySource: 'remote' | 'cache' | 'baseline' | null
  registryError: string | null
  registryLoading: boolean

  addProvider: (descriptor: MediaProviderDescriptor) => void
  removeProvider: (id: string) => void
  setProviderEnabled: (id: string, enabled: boolean) => void
  setSelectedModel: (modelId: string | null) => void
  refresh: (options?: MediaRefreshOptions) => Promise<void>
  /**
   * Pull the remote media registry and ADD anything new.
   *
   * Only ever adds. A provider the user already has - including one they
   * disabled or edited - is left exactly as it is, because their configuration
   * is theirs and a registry commit must not overwrite it.
   */
  refreshRegistry: (force?: boolean) => Promise<void>
  /** Models from every enabled provider, merged. Ids are provider-qualified. */
  models: () => MediaModelDescriptor[]
}

/**
 * Merge the bundled baseline with whatever was persisted. A persisted entry
 * wins outright so a user's own edits - notably having disabled a builtin -
 * survive, while a baseline entry added by a later release still appears.
 * A builtin a later release retired is dropped; a user's own entry by the
 * same name is kept.
 */
export const seedProviders = (
  saved: MediaProviderDescriptor[] = []
): MediaProviderDescriptor[] => {
  const persisted = saved.filter(
    (provider) =>
      !(provider.origin === 'builtin' && RETIRED_BUILTIN_PROVIDER_IDS.has(provider.id))
  )
  const known = new Set(persisted.map((provider) => provider.id))
  return [
    ...persisted,
    ...BASELINE_MEDIA_PROVIDERS.filter(
      (provider) => !known.has(provider.id)
    ).map((provider) => ({ ...provider })),
  ]
}

/** Copy a record without one key, without leaving unused bindings behind. */
const without = <T,>(
  record: Record<string, T>,
  key: string
): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key)
  )

/** Does this model id belong to this provider? Ids are `provider:local`. */
const belongsTo = (modelId: string, providerId: string): boolean =>
  modelId.startsWith(`${providerId}:`)

function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const useMediaProviderStore = create<MediaProviderState>()(
  persist(
    (set, get) => ({
      providers: seedProviders(),
      health: {},
      capabilities: {},
      errors: {},
      selectedModelId: null,
      refreshing: false,
      registrySource: null,
      registryError: null,
      registryLoading: false,

      addProvider: (descriptor) =>
        set((state) => {
          // Ids key the selection state and qualify every model id, so a
          // duplicate would make both ambiguous. First writer wins.
          if (state.providers.some((p) => p.id === descriptor.id)) return state
          return { providers: [...state.providers, { ...descriptor }] }
        }),

      removeProvider: (id) =>
        set((state) => {
          const target = state.providers.find((p) => p.id === id)
          // A builtin is part of the bundle; removing it would just come back
          // on the next launch. Disabling is the honest operation.
          if (!target || target.origin === 'builtin') return state

          return {
            providers: state.providers.filter((p) => p.id !== id),
            health: without(state.health, id),
            capabilities: without(state.capabilities, id),
            errors: without(state.errors, id),
            selectedModelId:
              state.selectedModelId && belongsTo(state.selectedModelId, id)
                ? null
                : state.selectedModelId,
          }
        }),

      setProviderEnabled: (id, enabled) =>
        set((state) => ({
          providers: state.providers.map((provider) =>
            provider.id === id ? { ...provider, enabled } : provider
          ),
          // A selection pointing into a provider the user just switched off
          // would otherwise sit there looking valid and fail at submit.
          selectedModelId:
            !enabled &&
            state.selectedModelId &&
            belongsTo(state.selectedModelId, id)
              ? null
              : state.selectedModelId,
        })),

      setSelectedModel: (modelId) => set({ selectedModelId: modelId }),

      models: () => {
        const { providers, capabilities } = get()
        return providers
          .filter((provider) => provider.enabled)
          .flatMap((provider) => capabilities[provider.id]?.models ?? [])
      },

      refreshRegistry: async (force = false) => {
        set({ registryLoading: true })
        // Documented as never throwing, so there is no try/catch here for
        // control flow - only the state write.
        const result = await getMediaProvidersOrFallback({ force })

        set((state) => {
          const known = new Set(state.providers.map((provider) => provider.id))
          const added = result.providers.filter(
            (provider) => !known.has(provider.id)
          )

          return {
            providers: added.length
              ? [...state.providers, ...added.map((p) => ({ ...p }))]
              : state.providers,
            registrySource: result.source,
            registryError: result.error ?? null,
            registryLoading: false,
          }
        })
      },

      refresh: async (options) => {
        const timeoutMs = options?.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
        const targets = get().providers.filter(
          (provider) =>
            provider.enabled &&
            (!options?.providerId || provider.id === options.providerId)
        )

        set({ refreshing: true })

        // allSettled, one timeout each, and results written per provider: a
        // provider that is down, slow or malformed must never stop another's
        // capabilities from loading.
        const results = await Promise.allSettled(
          targets.map(async (provider) => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            try {
              const adapter = createMediaAdapter(provider)
              const health = await adapter.health(controller.signal)
              // Asking an offline provider for capabilities just produces a
              // second, less useful error.
              const capabilities =
                health.state === 'online'
                  ? await adapter.capabilities(controller.signal)
                  : undefined
              return { id: provider.id, health, capabilities }
            } finally {
              clearTimeout(timer)
            }
          })
        )

        set((state) => {
          const health = { ...state.health }
          const capabilities = { ...state.capabilities }
          const errors = { ...state.errors }

          results.forEach((result, index) => {
            const provider = targets[index]
            if (!provider) return

            if (result.status === 'rejected') {
              // Includes an adapter this build does not bundle, and a timeout.
              health[provider.id] = {
                state: 'offline',
                detail: detailOf(result.reason),
              }
              errors[provider.id] = detailOf(result.reason)
              delete capabilities[provider.id]
              return
            }

            health[provider.id] = result.value.health
            if (result.value.capabilities) {
              capabilities[provider.id] = result.value.capabilities
              errors[provider.id] = null
            } else {
              delete capabilities[provider.id]
              // Name the state and the reason together. A bare provider detail
              // ("refused") does not tell the user what it is a symptom of, and
              // a bare state ("offline") does not tell them why.
              const { state: healthState, detail } = result.value.health
              errors[provider.id] = detail
                ? `Provider "${provider.label}" is ${healthState}: ${detail}`
                : `Provider "${provider.label}" is ${healthState}.`
            }
          })

          const selectedStillValid =
            !state.selectedModelId ||
            Object.values(capabilities).some((entry) =>
              entry.models.some((model) => model.id === state.selectedModelId)
            )

          return {
            health,
            capabilities,
            errors,
            refreshing: false,
            selectedModelId: selectedStillValid ? state.selectedModelId : null,
          }
        })
      },
    }),
    {
      name: localStorageKey.mediaProviders,
      storage: createJSONStorage(() => localStorage),
      // Only the user's configuration is persisted. Live state is re-derived on
      // every launch, because stale health is worse than no health.
      partialize: (state) => ({
        providers: state.providers,
        selectedModelId: state.selectedModelId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<MediaProviderState> | undefined
        return {
          ...current,
          ...saved,
          providers: seedProviders(saved?.providers),
        }
      },
    }
  )
)

/**
 * Synchronous accessor for non-React code, mirroring
 * `getRegistryProvidersSync`.
 */
export const getMediaProvidersSync = (): MediaProviderDescriptor[] =>
  useMediaProviderStore.getState().providers

/** Enabled providers only — what a submit or a refresh should consider. */
export const getEnabledMediaProvidersSync = (): MediaProviderDescriptor[] =>
  getMediaProvidersSync().filter((provider) => provider.enabled)
