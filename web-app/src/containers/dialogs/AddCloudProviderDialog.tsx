import { useCallback, useMemo, useState } from 'react'
import { IconChevronRight, IconPlus } from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ConnectProviderDialog } from '@/containers/dialogs/ConnectProviderDialog'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'
import { getProviderTitle } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface AddCloudProviderDialogProps {
  /** Creates an OpenAI-compatible provider under a user-supplied name. */
  onCreateCustomProvider: (name: string) => void
  children: React.ReactNode
}

/**
 * First step of the "add cloud provider" flow: a catalog of registry providers
 * the user has not connected yet, plus a "Custom" entry for any other
 * OpenAI-compatible endpoint. Picking an entry hands off to
 * {@link ConnectProviderDialog}; already-connected providers are absent here
 * because they live in Settings → Model Providers → Cloud.
 */
export function AddCloudProviderDialog({
  onCreateCustomProvider,
  children,
}: AddCloudProviderDialogProps) {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const catalog = useProviderRegistryStore((state) => state.providers)

  const [isOpen, setIsOpen] = useState(false)
  const [view, setView] = useState<'catalog' | 'custom'>('catalog')
  const [customName, setCustomName] = useState('')
  const [connecting, setConnecting] = useState<ProviderObject | null>(null)

  const available = useMemo(() => {
    return catalog
      .filter((entry) => {
        const added = providers.find((item) => item.provider === entry.provider)
        return !added?.active
      })
      .slice()
      .sort((a, b) =>
        getProviderTitle(a.provider).localeCompare(getProviderTitle(b.provider))
      )
  }, [catalog, providers])

  const savedKeys = useMemo(() => {
    return new Set(
      providers
        .filter((item) => Boolean(item.api_key?.trim()))
        .map((item) => item.provider)
    )
  }, [providers])

  const closeAll = useCallback(() => {
    setIsOpen(false)
    setView('catalog')
    setCustomName('')
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open)
      if (!open) {
        setView('catalog')
        setCustomName('')
      }
    },
    []
  )

  const handleSelect = useCallback(
    (entry: ProviderObject) => {
      closeAll()
      setConnecting(entry)
    },
    [closeAll]
  )

  const handleCreateCustom = useCallback(() => {
    const name = customName.trim()
    if (!name) return
    onCreateCustomProvider(name)
    closeAll()
  }, [customName, onCreateCustomProvider, closeAll])

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>{children}</DialogTrigger>
        <DialogContent className="sm:max-w-[720px] lg:max-w-[720px] xl:max-w-[720px] max-w-[90vw]">
          {view === 'catalog' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('provider:addProviderTitle')}</DialogTitle>
                <DialogDescription>
                  {t('provider:addProviderDescription')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {available.map((entry) => (
                  <button
                    key={entry.provider}
                    type="button"
                    className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 hover:bg-secondary px-3 py-2.5 text-left transition-colors cursor-pointer"
                    onClick={() => handleSelect(entry)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ProvidersAvatar provider={entry} />
                      <div className="min-w-0">
                        <p className="font-medium text-foreground truncate">
                          {getProviderTitle(entry.provider)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {savedKeys.has(entry.provider)
                            ? t('provider:keySaved')
                            : entry.models.length > 0
                              ? t('provider:modelsAvailable')
                              : t('provider:keyConnectionOnly')}
                        </p>
                      </div>
                    </div>
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-muted-foreground"
                    />
                  </button>
                ))}

                <button
                  type="button"
                  className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 hover:bg-secondary px-3 py-2.5 text-left transition-colors cursor-pointer"
                  onClick={() => setView('custom')}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex size-4.5 rounded-full border items-center justify-center">
                      <IconPlus size={11} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-foreground truncate">
                        {t('provider:custom')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('provider:customDescription')}
                      </p>
                    </div>
                  </div>
                  <IconChevronRight
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              </div>

              {available.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('provider:allProvidersAdded')}
                </p>
              )}
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('provider:addOpenAIProvider')}</DialogTitle>
                <DialogDescription>
                  {t('provider:customDescription')}
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t('provider:enterNameForProvider')}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && customName.trim()) {
                    e.preventDefault()
                    handleCreateCustom()
                  }
                }}
              />
              <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className="hover:no-underline w-full sm:w-auto"
                  onClick={() => setView('catalog')}
                >
                  {t('common:cancel')}
                </Button>
                <Button
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={!customName.trim()}
                  onClick={handleCreateCustom}
                >
                  {t('common:create')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConnectProviderDialog
        provider={connecting}
        open={Boolean(connecting)}
        onOpenChange={(open) => {
          if (!open) setConnecting(null)
        }}
      />
    </>
  )
}
