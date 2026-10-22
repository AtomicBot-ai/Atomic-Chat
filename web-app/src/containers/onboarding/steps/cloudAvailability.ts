import { useMemo } from 'react'

import { selectCloudGalleryProviders } from '@/containers/dialogs/AddCloudProviderDialog'
import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * The cloud providers the cloud step offers, in the Add provider gallery's
 * order: everything that talks to somebody else's server and connects with a
 * key or a sign-in.
 */
export function useCloudGalleryProviders(): ModelProvider[] {
  const providers = useModelProvider((state) => state.providers)
  return useMemo(() => selectCloudGalleryProviders(providers), [providers])
}

/**
 * Cloud providers the cloud step can offer. Connected ones still count: the
 * step shows them as connected, and must not vanish under a user who has just
 * connected the last one.
 */
export function useCloudProviderCount(): number {
  return useCloudGalleryProviders().length
}
