/**
 * What is known about a provider's saved API key beyond "there is one".
 *
 * A saved key used to mean "Connected", even when the provider had just
 * answered 401 to it. Two facts now qualify that:
 *
 *  - `unverified` — the key was saved while the provider could not be asked
 *    about it (no network, a timeout, a server error);
 *  - `rejected` — the provider refused it, during a chat.
 *
 * No entry means nothing contradicts the key: it was verified when saved, or
 * it predates verification. An entry carries a fingerprint of the key it was
 * recorded for and is ignored once the key changes, so a key replaced on any
 * screen never inherits the old one's verdict.
 *
 * Persisted, unlike the endpoint ping and model-fetch stores: "configured, not
 * verified" must still read so after a restart rather than turn into
 * "Connected" without anything having been checked. Kept apart from the
 * provider store, whose shape stays as it is.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'

export type ProviderKeyState = 'unverified' | 'rejected'

export type ProviderKeyStatus = {
  state: ProviderKeyState
  /** Why, readable as is. */
  message: string
  /** {@link keyFingerprint} of the key this applies to. */
  key: string
  at: number
}

/** Long provider error bodies are cut here: the reason, not the whole reply. */
const MAX_MESSAGE_LENGTH = 300

/**
 * A short, non-reversible tag for a key (32-bit FNV-1a), so an entry can tell
 * whether it still describes the key the provider holds now.
 */
export function keyFingerprint(apiKey: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < apiKey.length; i++) {
    hash ^= apiKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

type ProviderKeyStatusState = {
  statuses: Record<string, ProviderKeyStatus>
  /** Record `state` for `apiKey` of `provider`, replacing what was there. */
  setStatus: (
    provider: string,
    apiKey: string,
    state: ProviderKeyState,
    message: string
  ) => void
  /** Nothing contradicts the provider's key any more. */
  clear: (provider: string) => void
}

export const useProviderKeyStatusStore = create<ProviderKeyStatusState>()(
  persist(
    (set) => ({
      statuses: {},
      setStatus: (provider, apiKey, state, message) =>
        set((current) => ({
          statuses: {
            ...current.statuses,
            [provider]: {
              state,
              message: message.slice(0, MAX_MESSAGE_LENGTH),
              key: keyFingerprint(apiKey.trim()),
              at: Date.now(),
            },
          },
        })),
      clear: (provider) =>
        set((current) => {
          if (!(provider in current.statuses)) return current
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [provider]: _, ...rest } = current.statuses
          return { statuses: rest }
        }),
    }),
    {
      name: localStorageKey.providerKeyStatus,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ statuses: state.statuses }),
    }
  )
)

/**
 * The status that applies to `provider` as it is now: none without a key, and
 * none once the key differs from the one the status was recorded for.
 */
export function keyStatusFor(
  provider: Pick<ModelProvider, 'provider' | 'api_key'> | undefined,
  statuses: Record<string, ProviderKeyStatus>
): ProviderKeyStatus | undefined {
  const apiKey = provider?.api_key?.trim()
  if (!provider || !apiKey) return undefined
  const status = statuses[provider.provider]
  return status && status.key === keyFingerprint(apiKey) ? status : undefined
}

/** {@link keyStatusFor}, re-rendering when the statuses change. */
export function useProviderKeyStatus(
  provider: Pick<ModelProvider, 'provider' | 'api_key'> | undefined
): ProviderKeyStatus | undefined {
  const statuses = useProviderKeyStatusStore((state) => state.statuses)
  return keyStatusFor(provider, statuses)
}
