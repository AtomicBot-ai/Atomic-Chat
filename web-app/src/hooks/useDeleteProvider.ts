import { useCallback } from 'react'
import { EngineManager } from '@janhq/core'
import { toast } from 'sonner'

import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isAccountManagedProvider } from '@/lib/account-remote-providers'
import { isKnownProvider } from '@/stores/provider-registry-store'

/**
 * Only a provider the user added can be deleted: never one the catalogue
 * ships, never a local engine, never one remote access through the account
 * keeps (it goes when that computer is disconnected).
 */
export function canDeleteProvider(
  provider: ProviderObject | undefined
): provider is ProviderObject {
  return (
    provider !== undefined &&
    !isAccountManagedProvider(provider) &&
    !isKnownProvider(provider.provider) &&
    !EngineManager.instance().get(provider.provider)
  )
}

/**
 * Delete a provider the user added, and the favourites that pointed at its
 * models. The caller confirms first and decides where to go afterwards.
 */
export function useDeleteProvider() {
  const { t } = useTranslation()
  const { deleteProvider } = useModelProvider()
  const { favoriteModels, removeFavorite } = useFavoriteModel()

  return useCallback(
    (provider: ProviderObject) => {
      const providerModelIds = provider.models.map((model) => model.id)
      favoriteModels.forEach((favoriteModel) => {
        if (providerModelIds.includes(favoriteModel.id)) {
          removeFavorite(favoriteModel.id)
        }
      })

      deleteProvider(provider.provider)
      toast.success(t('providers:deleteProvider.title'), {
        id: `delete-provider-${provider.provider}`,
        description: t('providers:deleteProvider.success', {
          provider: provider.provider,
        }),
      })
    },
    [deleteProvider, favoriteModels, removeFavorite, t]
  )
}
