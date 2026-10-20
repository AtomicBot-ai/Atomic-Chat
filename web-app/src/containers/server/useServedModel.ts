import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { getProviderTitle } from '@/lib/utils'

/**
 * The engine and model the server serves while it runs, and the ones it will
 * load on the next start while it is stopped.
 */
export function useServedModel(running: boolean): {
  engine?: string
  model?: string
} {
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const lastServerModels = useLocalApiServer((state) => state.lastServerModels)
  const served = (running ? lastServerModels[0] : undefined) ?? defaultModel
  return {
    engine: served ? getProviderTitle(served.provider) : undefined,
    model: served?.model,
  }
}
