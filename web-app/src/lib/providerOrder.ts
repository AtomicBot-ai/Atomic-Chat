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
  'foundation-models': 4,
}

/**
 * Returns a new array ordered for the Settings provider lists. The input is
 * not mutated — callers pass store-owned arrays straight in.
 */
export const sortProvidersForSettings = <T extends { provider: string }>(
  providers: T[]
): T[] =>
  providers.slice().sort((a, b) => {
    const aPriority = PROVIDER_PRIORITY[a.provider] ?? Number.MAX_SAFE_INTEGER
    const bPriority = PROVIDER_PRIORITY[b.provider] ?? Number.MAX_SAFE_INTEGER

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    return getProviderTitle(a.provider).localeCompare(
      getProviderTitle(b.provider)
    )
  })
