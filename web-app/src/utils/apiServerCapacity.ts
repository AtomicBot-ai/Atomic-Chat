/**
 * Reads the two capacity numbers the API dashboard shows — context length and
 * concurrent slots — from the provider/model store.
 *
 * Both are deliberately resolved here rather than in the Rust proxy. The proxy
 * has no `n_ctx` (`SessionInfo` does not carry one) and a copy there would go
 * stale immediately, because auto-increase-ctx reloads are driven from
 * TypeScript and land in this same store via `DataProvider.applyNewCtxLen`.
 */

import { useModelProvider } from '@/hooks/useModelProvider'

type ControllerProps = { value?: unknown } | undefined

function providerSetting(providerName: string, key: string): unknown {
  const provider = useModelProvider.getState().getProviderByName(providerName)
  const setting = provider?.settings?.find((s) => s.key === key)
  return (setting?.controller_props as ControllerProps)?.value
}

/** The model's configured context window, if the store knows one. */
export function getModelContextLength(
  modelId?: string | null
): number | undefined {
  if (!modelId) return undefined
  for (const provider of useModelProvider.getState().providers) {
    const model = provider?.models?.find((m) => m.id === modelId)
    const value = (
      model?.settings?.ctx_len?.controller_props as ControllerProps
    )?.value
    if (typeof value === 'number' && value > 0) return value
  }
  return undefined
}

export function getProviderNameForModel(
  modelId?: string | null
): string | undefined {
  if (!modelId) return undefined
  return useModelProvider
    .getState()
    .providers.find((p) => p?.models?.some((m) => m.id === modelId))?.provider
}

/**
 * How many requests the backend can serve at once.
 *
 * Mirrors `args.rs`: `--parallel` is only passed in concurrent mode, and it is
 * floored at 2 there. Reading `concurrent_slots` on its own would report "0/4
 * busy" for a user who has slots configured but concurrent mode switched off,
 * which is a single-slot server.
 */
export function getConcurrentSlots(providerName?: string): number {
  if (!providerName) return 1
  if (!providerSetting(providerName, 'concurrent_mode')) return 1
  const configured = Number(providerSetting(providerName, 'concurrent_slots'))
  if (!Number.isFinite(configured) || configured <= 0) return 2
  return Math.max(configured, 2)
}
