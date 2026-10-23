import { useMemo } from 'react'

import { selectCloudGalleryProviders } from '@/containers/dialogs/AddCloudProviderDialog'
import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * The prototype's order for the step: the names people come in knowing, then
 * the rest of the gallery as it stands. The Add provider dialog ranks by
 * connections made, which suits a returning user, not a first look.
 */
const ONBOARDING_ORDER: readonly string[] = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'chatgpt',
  'deepseek',
  'xai',
  'groq',
  'mistral',
]

/** The provider the step opens on: one key gives every model family. */
export const ONBOARDING_FIRST_PICK = 'openrouter'

const onboardingRank = (providerName: string): number => {
  const index = ONBOARDING_ORDER.indexOf(providerName)
  return index === -1 ? ONBOARDING_ORDER.length : index
}

/**
 * The cloud providers the cloud step offers: the Add provider gallery's, in
 * the step's own order. Everything that talks to somebody else's server and
 * connects with a key or a sign-in.
 */
export function selectOnboardingCloudProviders(
  providers: ModelProvider[]
): ModelProvider[] {
  return selectCloudGalleryProviders(providers)
    .map((provider, position) => ({ provider, position }))
    .sort(
      (a, b) =>
        onboardingRank(a.provider.provider) -
          onboardingRank(b.provider.provider) || a.position - b.position
    )
    .map(({ provider }) => provider)
}

export function useCloudGalleryProviders(): ModelProvider[] {
  const providers = useModelProvider((state) => state.providers)
  return useMemo(() => selectOnboardingCloudProviders(providers), [providers])
}

/**
 * Cloud providers the cloud step can offer. Connected ones still count: the
 * step shows them as connected, and must not vanish under a user who has just
 * connected the last one.
 */
export function useCloudProviderCount(): number {
  return useCloudGalleryProviders().length
}
