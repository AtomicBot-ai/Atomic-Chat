import { useMemo } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { HUB_ENGINES, type HubEngine } from '@/lib/hub-model-engines'
import type { ModelFormat } from '@/lib/model-card'

/**
 * The engines the Hub offers on this machine: one per format it lists, and for GGUF the default
 * llama.cpp plus TurboQuant where its provider is installed (it may be off on a fresh Windows or
 * Linux install).
 */
export function useHubEngines(
  availableFormats: readonly ModelFormat[]
): HubEngine[] {
  const hasTurboQuant = useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === 'llamacpp')
  )
  const formats = availableFormats.join(',')
  return useMemo(() => {
    const offered = formats.split(',')
    return HUB_ENGINES.filter(
      (engine) =>
        offered.includes(engine.format) &&
        (engine.id !== 'llamacpp' || hasTurboQuant)
    )
  }, [formats, hasTurboQuant])
}
