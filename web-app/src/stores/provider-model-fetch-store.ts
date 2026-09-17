import { create } from 'zustand'

/**
 * The last live `/v1/models` failure per provider.
 *
 * ATO — #293: a custom OpenAI-compatible provider whose model listing fails
 * showed nothing but an empty list. The failure was reported once, as a
 * transient toast on the page that triggered the refresh — so a user who
 * navigated to the model picker (which does not fetch at all) saw a provider
 * that looked connected and simply had no models, with no way to tell an
 * expired key from an empty catalog.
 *
 * Deliberately in-memory: this is the state of the last attempt in this
 * session, not a fact about the provider worth persisting across restarts.
 */
type ProviderModelFetchState = {
  errors: Record<string, string>
  setFetchError: (provider: string, error: string) => void
  clearFetchError: (provider: string) => void
}

export const useProviderModelFetchStore = create<ProviderModelFetchState>(
  (set) => ({
    errors: {},
    setFetchError: (provider, error) =>
      set((state) => ({ errors: { ...state.errors, [provider]: error } })),
    clearFetchError: (provider) =>
      set((state) => {
        if (!(provider in state.errors)) return state
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [provider]: _, ...rest } = state.errors
        return { errors: rest }
      }),
  })
)

/** The last live model-listing failure for `provider`, if there was one. */
export function providerModelFetchError(provider: string): string | undefined {
  return useProviderModelFetchStore.getState().errors[provider]
}
