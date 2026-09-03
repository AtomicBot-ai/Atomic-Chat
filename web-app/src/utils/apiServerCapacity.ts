/**
 * Reads the model's context length out of the provider/model store.
 *
 * Deliberately resolved here rather than in the Rust proxy: the proxy has no
 * `n_ctx` (`SessionInfo` does not carry one) and a copy there would go stale
 * immediately, because auto-increase-ctx reloads are driven from TypeScript and
 * land in this same store via `DataProvider.applyNewCtxLen`.
 */

import { useModelProvider } from '@/hooks/useModelProvider'

type ControllerProps = { value?: unknown } | undefined

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
