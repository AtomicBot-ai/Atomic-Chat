import { create } from 'zustand'

import type { EndpointCheckResult } from '@/services/providers/types'

/**
 * Custom Endpoint's last "Ping" per provider, and which ones are being pinged.
 *
 * In memory on purpose, like `provider-model-fetch-store`: a ping says how the
 * server answered this session, not a fact about the provider worth
 * persisting — and the provider store's shape stays as it is.
 */
type EndpointCheckState = {
  results: Record<string, EndpointCheckResult>
  checking: Record<string, boolean>
  setChecking: (provider: string) => void
  setResult: (provider: string, result: EndpointCheckResult) => void
  /** Forget a provider's result: its address changed, or it is gone. */
  clear: (provider: string) => void
}

const without = <T>(record: Record<string, T>, key: string) => {
  if (!(key in record)) return record
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [key]: _, ...rest } = record
  return rest
}

export const useEndpointCheckStore = create<EndpointCheckState>((set) => ({
  results: {},
  checking: {},
  setChecking: (provider) =>
    set((state) => ({ checking: { ...state.checking, [provider]: true } })),
  setResult: (provider, result) =>
    set((state) => ({
      results: { ...state.results, [provider]: result },
      checking: without(state.checking, provider),
    })),
  clear: (provider) =>
    set((state) => ({
      results: without(state.results, provider),
      checking: without(state.checking, provider),
    })),
}))
