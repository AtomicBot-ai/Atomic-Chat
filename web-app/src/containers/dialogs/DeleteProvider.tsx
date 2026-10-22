import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

import { CardItem } from '../Card'
import { useModelProvider } from '@/hooks/useModelProvider'
import { canDeleteProvider, useDeleteProvider } from '@/hooks/useDeleteProvider'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  provider?: ProviderObject
  /**
   * Where to go once the provider is gone. Defaults to the Settings provider
   * detail page, which is where this dialog has always lived; the Cloud page
   * passes its own so a delete there doesn't bounce the user into Settings.
   */
  onDeleted?: () => void
}
const DeleteProvider = ({ provider, onDeleted }: Props) => {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const deleteProvider = useDeleteProvider()
  const router = useRouter()
  if (!canDeleteProvider(provider)) return null

  const removeProvider = async () => {
    deleteProvider(provider)
    setTimeout(() => {
      if (onDeleted) {
        onDeleted()
        return
      }
      router.navigate({
        to: route.settings.providers,
        params: {
          providerName: providers[0].provider,
        },
      })
    }, 0)
  }

  return (
    <CardItem
      title={t('providers:deleteProvider.title')}
      description={t('providers:deleteProvider.description')}
      actions={
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t('providers:deleteProvider.delete')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('providers:deleteProvider.confirmTitle', {
                  provider: provider.provider,
                })}
              </DialogTitle>
              <DialogDescription>
                {t('providers:deleteProvider.confirmDescription')}
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="mt-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm" className="hover:no-underline">
                  {t('providers:deleteProvider.cancel')}
                </Button>
              </DialogClose>
              <DialogClose asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={removeProvider}
                >
                  {t('providers:deleteProvider.delete')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    />
  )
}
export default DeleteProvider
