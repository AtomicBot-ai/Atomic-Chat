import { useMemo } from 'react'

import { useImageSetting } from '@/hooks/useImageSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { describeMediaModel, isMediaConnected, mediaModelsOf } from '@/lib/media-models'
import type {
  ImageModelDescriptor,
  MediaKind,
  MediaModelDescriptor,
  MediaTarget,
  VideoModelDescriptor,
} from '@/services/media/types'
import { listingKey, useMediaCatalog } from '@/stores/media-catalog-store'

/** One provider's enabled models of a kind, described. */
export type RemoteMediaGroup = {
  provider: ProviderObject
  models: Array<{ model: ProviderMediaModel; descriptor: MediaModelDescriptor }>
}

/**
 * Every connected provider's enabled models of `kind`, in the provider list's order: the remote
 * sections of the Images and Video pickers. Empty while the core has no remote media.
 */
export function useRemoteMediaGroups(kind: MediaKind): RemoteMediaGroup[] {
  const providers = useModelProvider((state) => state.providers)
  const catalog = useMediaCatalog((state) => state.catalog)
  const available = useMediaCatalog((state) => state.available)
  const listings = useMediaCatalog((state) => state.listings)
  return useMemo(() => {
    if (!available || catalog === null) return []
    const groups: RemoteMediaGroup[] = []
    for (const provider of providers) {
      if (!provider.active || !isMediaConnected(provider)) continue
      const listed = listings[listingKey(provider.provider, kind)]?.models ?? []
      const models = mediaModelsOf(provider, kind).flatMap((model) => {
        const descriptor = describeMediaModel(provider, model, catalog, listed)
        return descriptor ? [{ model, descriptor }] : []
      })
      if (models.length > 0) groups.push({ provider, models })
    }
    return groups
  }, [providers, catalog, available, listings, kind])
}

export type ResolvedRemoteTarget<D extends MediaModelDescriptor> = {
  target: MediaTarget
  provider: ProviderObject
  descriptor: D
}

/** The picked provider model of a page, while it is still enabled and its provider connected. */
export function useRemoteMediaTarget(kind: 'image'): ResolvedRemoteTarget<ImageModelDescriptor> | null
export function useRemoteMediaTarget(kind: 'video'): ResolvedRemoteTarget<VideoModelDescriptor> | null
export function useRemoteMediaTarget(kind: MediaKind): ResolvedRemoteTarget<MediaModelDescriptor> | null {
  const image = useImageSetting((state) => state.selectedRemote)
  const video = useVideoSetting((state) => state.selectedRemote)
  const picked = kind === 'image' ? image : video
  const groups = useRemoteMediaGroups(kind)
  return useMemo(() => {
    if (!picked) return null
    const group = groups.find((g) => g.provider.provider === picked.provider)
    const entry = group?.models.find((m) => m.model.id === picked.model)
    if (!group || !entry) return null
    return { target: picked, provider: group.provider, descriptor: entry.descriptor }
  }, [picked, groups])
}

/** Whether any connected provider offers models of `kind` here. */
export function useHasRemoteMedia(kind: MediaKind): boolean {
  return useRemoteMediaGroups(kind).length > 0
}
