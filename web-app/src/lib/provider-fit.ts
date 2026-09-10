/**
 * Whether a local engine loads with llama.cpp's `--fit` — the flag that lets
 * the engine pick the largest context that fits this device's memory.
 *
 * Read from the provider's own settings (it is an engine flag, not a model
 * one) so the slider, the auto-grow ladder and the `model_load` event all
 * agree on which regime the context is in.
 */

/** Engines that understand `--fit`. MLX sizes its context explicitly. */
export const FIT_PROVIDERS: ReadonlySet<string> = new Set([
  'llamacpp',
  'llamacpp-upstream',
])

type ProviderLike = {
  provider: string
  settings?: ReadonlyArray<{
    key: string
    controller_props?: { value?: unknown }
  }>
}

/** `true`/`false` when the provider carries a fit setting; `null` otherwise. */
export function readProviderFit(
  provider: ProviderLike | null | undefined
): boolean | null {
  if (!provider || !FIT_PROVIDERS.has(provider.provider)) return null
  const setting = provider.settings?.find((s) => s.key === 'fit')
  if (!setting) return null
  const value = setting.controller_props?.value
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}
