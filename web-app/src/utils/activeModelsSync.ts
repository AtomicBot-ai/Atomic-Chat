import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ModelsService } from '@/services/models/types'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

/**
 * Find the provider that owns a model id by scanning the provider registry.
 * Returns `undefined` when the model isn't known yet (e.g. stale custom
 * models removed from providers).
 */
function findOwningProviderName(modelId: string): string | undefined {
  const { providers } = useModelProvider.getState()
  return providers.find((p) => p.models?.some((m) => m.id === modelId))
    ?.provider
}

/**
 * Returns `true` when the given model id belongs to a cloud provider. Models
 * whose owning provider cannot be resolved (e.g. not yet hydrated) are
 * treated as non-cloud to avoid leaking stale state.
 */
function isCloudModel(modelId: string): boolean {
  const providerName = findOwningProviderName(modelId)
  if (!providerName) return false
  return !isLocalProvider(providerName)
}

/**
 * Merge a freshly-queried list of locally-loaded models with the cloud models
 * currently tracked in `useAppState.activeModels`.
 *
 * `serviceHub.models().getActiveModels()` only inspects on-device engines
 * (llamacpp / mlx / foundation-models), so naively calling
 * `setActiveModels(await getActiveModels())` from a screen mount wipes out
 * any cloud provider that was activated earlier in the session even though
 * the Local API Server proxy is still routing to it. Use this helper (or
 * {@link refreshActiveModels}) at every such refresh point to preserve the
 * cloud entry.
 */
export function preserveActiveCloudModels(
  freshLocal: readonly string[] | undefined | null
): string[] {
  const prevActive = useAppState.getState().activeModels
  const retainedCloud = prevActive.filter(isCloudModel)
  return Array.from(new Set([...(freshLocal ?? []), ...retainedCloud]))
}

/**
 * Replace `useAppState.activeModels` with the given local list, but keep any
 * active cloud model that was already there. Use this in place of
 * `setActiveModels(freshLocal)` after a `getActiveModels()` refresh.
 */
export function syncActiveModelsFromEngines(
  freshLocal: readonly string[] | undefined | null
): void {
  useAppState.getState().setActiveModels(preserveActiveCloudModels(freshLocal))
}

/**
 * Hydrate `useAppState.activeModels` when the Local API Server is discovered
 * already running (typically on app startup or when landing on a screen that
 * lazily syncs state).
 *
 * `useAppState` lives only in memory, so on a cold start — or after the user
 * navigates into a provider screen whose effect fires before
 * {@link switchToModel} has populated state — `activeModels` is empty even
 * though the server is actively proxying requests. The persisted
 * `defaultModelLocalApiServer` pointer tells us which cloud model the proxy
 * is serving; combine that with whatever local engines currently report so
 * the provider UI renders the correct Start/Stop button.
 */
export async function hydrateActiveModelsForRunningServer(
  modelsService: Pick<ModelsService, 'getActiveModels'>
): Promise<void> {
  const localActive = await modelsService
    .getActiveModels()
    .catch(() => [] as string[])

  const combined = new Set<string>(localActive ?? [])

  const serverDefault = useLocalApiServer.getState().defaultModelLocalApiServer
  if (serverDefault?.model && serverDefault?.provider) {
    const provider = useModelProvider
      .getState()
      .providers.find((p) => p.provider === serverDefault.provider)
    // Only surface a cloud default as active when it's still resolvable and
    // has credentials the proxy can route with. Local-engine defaults are
    // already represented by `localActive` above.
    if (
      provider &&
      !isLocalProvider(provider.provider) &&
      Boolean(provider.api_key)
    ) {
      combined.add(serverDefault.model)
    }
  }

  useAppState.getState().setActiveModels([...combined])
}
