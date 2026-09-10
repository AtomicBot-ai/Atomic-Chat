/**
 * "Refresh models" for one provider, in one place.
 *
 * Extracted verbatim from `routes/settings/providers/$providerName.tsx` when
 * the Cloud page grew a second Reload button. Behaviour is unchanged —
 * including the hybrid registry + live `/v1/models` pass, the
 * `supports_model_listing` opt-out and the three toast branches — so the two
 * screens cannot drift on what a refresh means.
 */

import { toast } from 'sonner'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getModelCapabilities } from '@/lib/models'
import type { ServiceHub } from '@/services'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

type Translate = (key: string, options?: Record<string, unknown>) => string

export type RefreshProviderModelsParams = {
  provider: ProviderObject
  serviceHub: Pick<ServiceHub, 'providers'>
  setProviders: (providers: ModelProvider[]) => void
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  t: Translate
}

export async function refreshProviderModels({
  provider,
  serviceHub,
  setProviders,
  updateProvider,
  t,
}: RefreshProviderModelsParams): Promise<void> {
  try {
    // Step 1 — Pull the latest manifest from our remote registry on GitHub
    // (the curated source for known cloud providers).
    try {
      await useProviderRegistryStore.getState().refresh({ force: true })
    } catch (err) {
      console.warn(
        `[providers:${provider.provider}] registry refresh failed:`,
        err
      )
    }

    const state = useProviderRegistryStore.getState()
    if (state.error) {
      toast.error(t('providers:models'), {
        description: state.error,
      })
      return
    }

    // Count models that will newly appear on this provider after the
    // registry merge — for the success toast.
    const fresh = await serviceHub.providers().getProviders()
    const registryProvider = fresh.find((p) => p.provider === provider.provider)
    const existingIds = new Set(provider.models.map((m) => m.id))
    let newCount = registryProvider
      ? registryProvider.models.filter((m) => !existingIds.has(m.id)).length
      : 0

    // Step 2 — Hybrid: also query the provider's live /v1/models endpoint
    // (ATO-209). The registry only covers known cloud providers; custom /
    // self-hosted providers (vLLM, llama-server, LM Studio, etc.) are
    // invisible to the registry, so this is the only path that surfaces
    // their actual model list. We do it for all non-local providers that
    // have a base_url configured. Errors are non-fatal — if the live
    // endpoint is unavailable we still apply the registry results, but we
    // remember the error so the toast can warn instead of falsely claiming
    // "no new models" (ATO-210).
    //
    // P2 (ATO — registry-driven behavior): a registry provider may opt out
    // of live model listing via `supports_model_listing: false` (some clouds
    // expose hundreds of junk/internal IDs at /v1/models). When the flag is
    // explicitly false we show the curated registry list only and skip the
    // live probe. Missing/true keeps the hybrid behavior.
    let liveNewModels: Model[] = []
    let liveFetchError: Error | null = null
    const registrySupportsListing =
      registryProvider?.supports_model_listing !== false
    if (
      provider.base_url &&
      !isLocalProvider(provider.provider) &&
      registrySupportsListing
    ) {
      try {
        const liveModelIds = await serviceHub
          .providers()
          .fetchModelsFromProvider(provider)

        // Collect IDs already present after the registry pass so we only
        // add genuinely new entries.
        const afterRegistryIds = new Set([
          ...existingIds,
          ...(registryProvider?.models ?? []).map((m) => m.id),
        ])
        liveNewModels = liveModelIds
          .filter((id) => !afterRegistryIds.has(id))
          .map((id) => ({
            id,
            model: id,
            name: id,
            capabilities: getModelCapabilities(provider.provider, id),
            version: '1.0',
          }))

        if (liveNewModels.length > 0) newCount += liveNewModels.length

        console.info(
          `[providers:${provider.provider}] live /models: ${liveModelIds.length} total, ${liveNewModels.length} new`
        )
      } catch (liveErr) {
        // Non-fatal: registry results still apply even if the live
        // endpoint is unreachable or returns an error. We surface the error
        // in the toast below so the user knows the list may be incomplete.
        liveFetchError =
          liveErr instanceof Error ? liveErr : new Error(String(liveErr))
        console.warn(
          `[providers:${provider.provider}] live /models fetch failed (non-fatal):`,
          liveErr
        )
      }
    }

    // Apply the registry refresh. `setProviders` merges catalog updates while
    // preserving API keys, base URLs, and user-tweaked settings per provider,
    // and never removes existing models.
    setProviders(fresh)

    // Persist the live-discovered models onto THIS provider. We cannot inject
    // into `fresh` because custom / self-hosted providers (AIML, Cerebras,
    // LM Studio, vLLM, …) are NOT part of getProviders() output — they live
    // only in useModelProvider state, so the old `fresh.map()` injection
    // silently dropped them (toast said "Added N" but the list stayed empty).
    // updateProvider operates on current state and works for both registry
    // and custom providers.
    if (liveNewModels.length > 0) {
      const current =
        useModelProvider.getState().getProviderByName(provider.provider) ??
        provider
      // Dedupe by id (first-seen wins) so both newly fetched duplicates and
      // any duplicates already persisted from an earlier refresh collapse to
      // a single row.
      const byId = new Map<string, Model>()
      for (const m of [...current.models, ...liveNewModels]) {
        if (m.id && !byId.has(m.id)) byId.set(m.id, m)
      }
      updateProvider(provider.provider, { models: Array.from(byId.values()) })
    }

    if (newCount > 0) {
      toast.success(t('providers:models'), {
        description: t('providers:refreshModelsSuccess', {
          count: newCount,
          provider: provider.provider,
        }),
      })
    } else if (liveFetchError) {
      // Live fetch failed, so the "no new models" result may be incomplete —
      // warn with the underlying error instead of a misleading success.
      toast.warning(t('providers:models'), {
        description: t('providers:refreshModelsLiveFailed', {
          provider: provider.provider,
          error:
            liveFetchError.message ||
            t('providers:refreshModelsFailed', {
              provider: provider.provider,
            }),
        }),
      })
    } else {
      toast.success(t('providers:models'), {
        description: t('providers:noNewModels'),
      })
    }
  } catch (err) {
    console.error(`[providers:${provider.provider}] refresh failed:`, err)
    const detail =
      err instanceof Error && err.message
        ? err.message
        : t('providers:refreshModelsFailed', { provider: provider.provider })
    toast.error(t('providers:models'), {
      description: detail,
    })
  }
}
