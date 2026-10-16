import { managedEngines } from '@/lib/managed-engines'
import { getProviderTitle } from '@/lib/utils'

/**
 * Display order for the provider lists in Settings (the sidebar list and the
 * provider overview cards). Anything not listed here — remote/cloud and
 * user-added providers — sorts after these, alphabetically by title.
 *
 * The local engines lead, with the TurboQuant fork (`llamacpp`) deliberately
 * placed BELOW `mlx` rather than beside `llamacpp-upstream`:
 *   - macOS ships MLX, so TurboQuant lands right under it.
 *   - Windows and Linux filter MLX out of these lists, so TurboQuant collapses
 *     to the slot right under upstream llama.cpp.
 * Either way it is never the first entry, and its title
 * ("llama.cpp turboquant") never sits directly beneath upstream's
 * ("llama.cpp"), where the two read as one duplicated row.
 */
const PROVIDER_PRIORITY: Record<string, number> = {
  'jan': 0,
  'llamacpp-upstream': 1,
  'mlx': 2,
  'llamacpp': 3,
  'atomic-prism': 4,
  'foundation-models': 5,
  // Every desktop OS (change add-foundry-local): after the engines that share a model folder, before
  // the managed ones.
  'foundry-local': 6,
}

/**
 * The managed engines (Linux and Windows) never share the list with MLX or
 * Foundation Models: they follow the llama.cpp engines there, in registry
 * order — vLLM, SGLang, TensorRT-LLM (changes add-vllm-runtime,
 * add-sglang-runtime). Read from the registry, so a new engine needs no entry.
 */
const MANAGED_PRIORITY_FROM = 7

const providerPriority = (provider: string): number => {
  if (Object.hasOwn(PROVIDER_PRIORITY, provider)) return PROVIDER_PRIORITY[provider]
  const managed = managedEngines().findIndex((engine) => engine.id === provider)
  return managed === -1 ? Number.MAX_SAFE_INTEGER : MANAGED_PRIORITY_FROM + managed
}

/**
 * Returns a new array ordered for the Settings provider lists. The input is
 * not mutated — callers pass store-owned arrays straight in.
 */
export const sortProvidersForSettings = <T extends { provider: string }>(
  providers: T[]
): T[] =>
  providers.slice().sort((a, b) => {
    const aPriority = providerPriority(a.provider)
    const bPriority = providerPriority(b.provider)

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    return getProviderTitle(a.provider).localeCompare(
      getProviderTitle(b.provider)
    )
  })
