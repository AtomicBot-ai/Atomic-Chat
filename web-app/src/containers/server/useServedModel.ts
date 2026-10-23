import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  compactModelDisplayName,
  modelVariantDetails,
} from '@/lib/model-display-name'
import { getProviderTitle } from '@/lib/utils'

/**
 * The engine and model the server serves while it runs, and the ones it will
 * load on the next start while it is stopped.
 */
export function useServedModel(running: boolean): {
  engine?: string
  /** The id clients pass as `model`, owner and quantization included. */
  model?: string
  /** The model's readable name: its nickname, else the id without owner, format or quant. */
  name?: string
  /** The quantization the id names ("IQ4_XS"), unless the name already reads it. */
  quant?: string
} {
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const lastServerModels = useLocalApiServer((state) => state.lastServerModels)
  const served = (running ? lastServerModels[0] : undefined) ?? defaultModel
  const nickname = useModelProvider((state) =>
    served
      ? state
          .getProviderByName(served.provider)
          ?.models.find((model) => model.id === served.model)?.displayName
      : undefined
  )
  if (!served) return {}
  const model: Model = { id: served.model, displayName: nickname }
  return {
    engine: getProviderTitle(served.provider),
    model: served.model,
    name: compactModelDisplayName(model),
    quant: modelVariantDetails(model).quant,
  }
}
