import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { mediaDialectOf, withListedModels } from '@/lib/media-models'
import { getProviderTitle } from '@/lib/utils'
import type { MediaKind } from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { registerRemoteProvider } from '@/utils/registerRemoteProvider'

/**
 * Connect a server that makes images or video (Automatic1111,
 * stable-diffusion.cpp): ask it for its models through the core and enable
 * every one it lists — that is what makes it connected. The core asks at the
 * address it has registered, so the one on screen is registered first.
 */
export function useConnectMediaServer(
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
) {
  const { t } = useTranslation()
  const listMediaModels = useMediaCatalog((state) => state.listModels)
  const [connecting, setConnecting] = useState(false)

  const connect = useCallback(
    async (provider: ProviderObject) => {
      const title = getProviderTitle(provider.provider)
      setConnecting(true)
      try {
        await registerRemoteProvider(provider)
        const catalog =
          useMediaCatalog.getState().catalog ??
          (await useMediaCatalog.getState().load())
        const kinds = (['image', 'video'] as const).filter(
          (kind): kind is MediaKind =>
            mediaDialectOf(provider, kind, catalog) !== undefined
        )
        const listings = await Promise.all(
          kinds.map((kind) => listMediaModels(provider.provider, kind))
        )
        const failed = listings.find(
          (listing) => listing.status === 'error' || !listing.live
        )
        if (failed) {
          toast.error(t('cloud:connection.mediaFailed', { provider: title }), {
            description: failed.error ?? undefined,
          })
          return
        }
        const listed = listings.flatMap((listing, index) =>
          listing.models.map((model) => ({
            id: model.id,
            kind: kinds[index] as MediaKind,
            name: model.name,
          }))
        )
        if (listed.length === 0) {
          toast.error(t('cloud:connection.mediaNoModels', { provider: title }))
          return
        }
        updateProvider(provider.provider, {
          media: withListedModels(provider.media, listed),
        })
        toast.success(
          t('cloud:connection.mediaConnected', {
            provider: title,
            count: listed.length,
          })
        )
      } catch (error) {
        toast.error(t('cloud:connection.mediaFailed', { provider: title }), {
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setConnecting(false)
      }
    },
    [listMediaModels, t, updateProvider]
  )

  return { connecting, connect }
}
