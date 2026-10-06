import { EngineManager } from '@janhq/core'

/**
 * Engines that decide for themselves whether they belong in the provider lists.
 *
 * TensorRT-LLM is built into every Linux and Windows app, but it can only run — or be set up — on
 * a machine with an NVIDIA GPU (x64 on Windows) and once the engine's descriptor is published — on
 * Windows also the environment manifest (spec `tensorrt-llm-desktop`).
 * Its extension asks the core and answers `isHidden()`; `refreshVisibility()` asks again, which the
 * provider settings do each time they open, so a descriptor published later shows the provider
 * without an app update.
 *
 * Two places have to agree: the provider list the engines produce (`getProviders`), and the
 * persisted store, which keeps every provider it has ever seen — a provider that was shown once
 * would otherwise stay listed after it became hidden.
 */

interface VisibilityGatedEngine {
  isHidden(): boolean
  refreshVisibility(): Promise<boolean>
  /** False while the engine has no answer yet: hidden, but not to be forgotten. */
  visibilityKnown?(): boolean
  /** The engine's settings as its extension registered them (managed engines: the core's schema). */
  getSettings?(): Promise<Array<{ key: string }>>
}

function isGated(engine: unknown): engine is VisibilityGatedEngine {
  return (
    !!engine &&
    typeof (engine as VisibilityGatedEngine).isHidden === 'function' &&
    typeof (engine as VisibilityGatedEngine).refreshVisibility === 'function'
  )
}

/** Whether an engine asked to stay out of the lists. Engines without a say never are. */
export function isEngineHidden(engine: unknown): boolean {
  return isGated(engine) && engine.isHidden()
}

export interface ProviderVisibilityStore {
  providers: Array<{ provider: string; settings?: Array<{ key: string }> }>
  setProviders(providers: ModelProvider[]): void
  deleteProvider(providerName: string): void
}

/**
 * Ask every gated engine again, then bring the provider store in line: visible ones through a fresh
 * `getProviders` (which already skips the hidden), hidden ones deleted from the store. Nothing
 * happens when no engine is gated, so platforms without such an engine pay nothing: `false` then,
 * `true` when an engine was asked.
 */
export async function refreshManagedProviders(options: {
  engines: Iterable<[string, unknown]>
  getProviders: () => Promise<ModelProvider[]>
  store: ProviderVisibilityStore
}): Promise<boolean> {
  const gated = [...options.engines].filter(
    (entry): entry is [string, VisibilityGatedEngine] => isGated(entry[1])
  )
  if (gated.length === 0) return false

  await Promise.all(gated.map(([, engine]) => engine.refreshVisibility()))
  const inStore = (name: string) => options.store.providers.some((p) => p.provider === name)
  const keysOf = (settings: Array<{ key: string }> | undefined) =>
    (settings ?? []).map((setting) => setting.key).join(',')
  // A shown engine whose stored settings list is not the one its extension registers: the store
  // kept it from an older extension (an app update that added settings), and since the provider is
  // already in the store nothing else would ever read its list again.
  const settingsChanged = async (name: string, engine: VisibilityGatedEngine) => {
    if (!engine.getSettings) return false
    const stored = options.store.providers.find((p) => p.provider === name)?.settings
    return keysOf(stored) !== keysOf(await engine.getSettings())
  }
  // A shown engine missing from the store or with an outdated settings list, or a hidden one still
  // in it (and known to be hidden), is what calls for a new list; otherwise the whole list is not
  // read again.
  const verdicts = await Promise.all(
    gated.map(async ([name, engine]) => {
      const known = engine.visibilityKnown?.() ?? true
      if (engine.isHidden()) return known && inStore(name)
      return !inStore(name) || (await settingsChanged(name, engine))
    })
  )
  if (!verdicts.some(Boolean)) return true
  options.store.setProviders(await options.getProviders())
  for (const [name, engine] of gated) {
    const known = engine.visibilityKnown?.() ?? true
    if (known && engine.isHidden() && inStore(name)) {
      options.store.deleteProvider(name)
    }
  }
  return true
}

/**
 * {@link refreshManagedProviders} against the app's own engines and provider store: what the app
 * runs once its first provider list is in, and each time the provider settings open.
 */
export async function refreshAppManagedProviders(
  getProviders: () => Promise<ModelProvider[]>
): Promise<boolean> {
  // Imported on use: this module is also imported by the providers service, which the store's
  // own module graph reaches, and a static import would close that cycle.
  const { useModelProvider } = await import('@/hooks/useModelProvider')
  return refreshManagedProviders({
    engines: EngineManager.instance().engines,
    getProviders,
    store: {
      // Read live: `setProviders` replaces the array this would otherwise hold on to.
      get providers() {
        return useModelProvider.getState().providers
      },
      setProviders: (providers) => useModelProvider.getState().setProviders(providers),
      deleteProvider: (name) => useModelProvider.getState().deleteProvider(name),
    },
  })
}
