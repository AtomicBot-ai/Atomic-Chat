import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * The provider object Agent mode should be judged against.
 *
 * Resolved *inside* the selector on purpose. `providers` loads asynchronously
 * at boot and changes again whenever an API key is saved, so calling
 * `getProviderByName` outside a selector subscribes only to `selectedProvider`,
 * reads a stale empty list, and leaves the Agent toggle disabled forever.
 */
export function useAgentProvider(): ModelProvider | undefined {
  return useModelProvider((state) =>
    state.getProviderByName(state.selectedProvider)
  )
}
