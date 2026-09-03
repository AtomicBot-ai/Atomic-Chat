import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

const LOCAL_ENGINE_PROVIDERS = new Set(['llamacpp', 'llamacpp-upstream', 'mlx'])

type ProviderLike = {
  provider: string
  active?: boolean
  models?: Array<{ id: string }>
}

/**
 * Pick the provider that should auto-start a freshly imported model.
 *
 * Both llama.cpp providers (`llamacpp` TurboQuant and `llamacpp-upstream`)
 * share one models directory, so every GGUF shows up under both. A plain
 * "first provider that lists the model" scan therefore depends on array
 * order and can land on the engine the user is NOT chatting with — which
 * loads the model twice (once here, once from the chat send path) and lets
 * the later `switchToModel` tear down the engine that is streaming.
 *
 * Priority:
 *   1. the currently selected provider, when it is a local engine that lists
 *      the model — this is the engine the next send will use anyway;
 *   2. the engine that emitted the import event (`eventProvider`);
 *   3. the default local provider;
 *   4. the first active provider listing the model (legacy behaviour);
 *   5. the default local provider's entry, if registered at all.
 *
 * Model ids are matched both verbatim and with `/` → `\` (Windows import
 * paths), mirroring the previous inline lookup.
 */
export function resolveImportedModelProvider<T extends ProviderLike>(
  modelId: string,
  providers: readonly T[],
  options: { selectedProvider?: string; eventProvider?: string } = {}
): T | undefined {
  const altId = modelId.replace(/\//g, '\\')
  const lists = (p: T) =>
    p.active !== false &&
    Boolean(p.models?.some((m) => m.id === modelId || m.id === altId))
  const byName = (name: string | undefined) =>
    name ? providers.find((p) => p.provider === name) : undefined

  const preferred = [
    LOCAL_ENGINE_PROVIDERS.has(options.selectedProvider ?? '')
      ? options.selectedProvider
      : undefined,
    options.eventProvider,
    LOCAL_LLAMACPP_PROVIDER,
  ]
  for (const name of preferred) {
    const candidate = byName(name)
    if (candidate && lists(candidate)) return candidate
  }

  return (
    providers.find(lists) ??
    providers.find((p) => p.provider === LOCAL_LLAMACPP_PROVIDER)
  )
}
