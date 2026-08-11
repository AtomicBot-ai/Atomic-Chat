import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import cloneDeep from 'lodash/cloneDeep'
import { IconEye, IconEyeOff, IconShieldCheck } from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface ConnectProviderDialogProps {
  /** Catalog entry for the provider being connected. */
  provider: ProviderObject | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const getApiKeyPlaceholder = (provider: ProviderObject): string | undefined => {
  const setting = provider.settings?.find((item) => item.key === 'api-key')
  const placeholder = setting?.controller_props?.placeholder
  return typeof placeholder === 'string' ? placeholder : undefined
}

/**
 * Second step of the "add cloud provider" flow: paste an API key for a
 * provider picked from the catalog. Saving both stores the key and flips
 * `active`, which is what makes the provider appear under Settings →
 * Model Providers → Cloud. Backend registration follows automatically from
 * `syncRemoteProviders` in `DataProvider`.
 */
export function ConnectProviderDialog({
  provider,
  open,
  onOpenChange,
}: ConnectProviderDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers, addProvider, updateProvider } = useModelProvider()
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)

  const existing = useMemo(
    () => providers.find((item) => item.provider === provider?.provider),
    [providers, provider]
  )

  useEffect(() => {
    if (!open) return
    setApiKey(existing?.api_key ?? '')
    setRevealed(false)
  }, [open, existing])

  if (!provider) return null

  const providerName = provider.provider
  const title = getProviderTitle(providerName)
  const hasModels = (existing?.models.length ?? provider.models.length) > 0

  const handleSave = () => {
    const trimmed = apiKey.trim()
    if (!trimmed) return

    // The provider detail screen renders the key from the `api-key` setting
    // rather than the top-level field, so both have to be written or the
    // input there would look empty right after connecting.
    const withKey = (settings: ProviderSetting[]) =>
      cloneDeep(settings ?? []).map((setting) =>
        setting.key === 'api-key'
          ? {
              ...setting,
              controller_props: { ...setting.controller_props, value: trimmed },
            }
          : setting
      )

    if (existing) {
      updateProvider(providerName, {
        api_key: trimmed,
        active: true,
        settings: withKey(existing.settings),
      })
    } else {
      // Deep-copied so the persisted provider never aliases the registry
      // store's own settings/models arrays.
      addProvider({
        ...cloneDeep(provider),
        api_key: trimmed,
        active: true,
        settings: withKey(provider.settings),
      })
    }

    onOpenChange(false)
    navigate({
      to: route.settings.providers,
      params: { providerName },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>{t('provider:addKeyTitle', { provider: title })}</DialogTitle>
          <DialogDescription>{t('provider:addKeyDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg bg-secondary/50 px-3 py-2.5">
          <ProvidersAvatar provider={provider} />
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">{title}</p>
            <p className="text-xs text-muted-foreground">
              {hasModels
                ? t('provider:supportsModelListing')
                : t('provider:keyConnectionOnly')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="connect-provider-api-key"
            className="text-sm font-medium text-foreground"
          >
            {t('provider:apiKey')}
          </label>
          <div className="relative">
            <Input
              id="connect-provider-api-key"
              autoFocus
              value={apiKey}
              type={revealed ? 'text' : 'password'}
              placeholder={getApiKeyPlaceholder(provider)}
              className="pr-9"
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && apiKey.trim()) {
                  e.preventDefault()
                  handleSave()
                }
              }}
            />
            <button
              type="button"
              aria-label={revealed ? 'Hide API key' : 'Show API key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <IconShieldCheck size={14} />
          <span>{t('provider:keyProtected')}</span>
        </div>

        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button
            variant="link"
            size="sm"
            className="hover:no-underline w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={!apiKey.trim()}
            onClick={handleSave}
          >
            {t('provider:saveKey')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
