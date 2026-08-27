import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
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
import { Card, CardItem } from '@/containers/Card'
import { CloudProviderSelect } from '@/containers/cloud/CloudProviderSelect'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import { InputControl } from '@/containers/dynamicControllerSetting/InputControl'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected, takesApiKey } from '@/lib/cloud-providers'
import { isOnboardingPending } from '@/lib/onboarding'
import { buildApiKeyUpdate, saveProviderApiKey } from '@/lib/provider-api-key'
import { getProviderTitle } from '@/lib/utils'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'
import { isKeylessRemoteProvider } from '@/utils/registerRemoteProvider'
import type { ServiceHub } from '@/services'

type CloudConnectionCardProps = {
  providers: ProviderObject[]
  selected: ProviderObject | undefined
  onSelect: (providerName: string) => void
  onAddCustom: () => void
  onDeleted: () => void
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  serviceHub: Pick<ServiceHub, 'providers'>
}

/** The `base-url` setting entry and the top-level mirror, written together. */
function buildBaseUrlUpdate(
  provider: ProviderObject,
  rawUrl: string
): Pick<ModelProvider, 'settings' | 'base_url'> {
  // Trim so a stray leading/trailing space (common on paste) doesn't leak into
  // request URLs as `/v1 /models` → 404. Normalise the stored setting value
  // too, not just the mirror field.
  const baseUrl = rawUrl.trim()
  const index = provider.settings.findIndex((s) => s.key === 'base-url')
  if (index === -1) return { settings: provider.settings, base_url: baseUrl }

  const settings = [...provider.settings]
  settings[index] = {
    ...settings[index],
    controller_props: { ...settings[index].controller_props, value: baseUrl },
  }
  return { settings, base_url: baseUrl }
}

/**
 * "Connection": pick a provider, then give it whatever it needs to work.
 *
 * Connect and disconnect are both expressed as writing the API key, because
 * that is what every downstream consumer already reads — `syncRemoteProviders`
 * registers the provider with the Rust proxy on the next `providers` change and
 * unregisters it when the key goes away. There is no separate "connected" flag
 * to keep in sync.
 */
export function CloudConnectionCard({
  providers,
  selected,
  onSelect,
  onAddCustom,
  onDeleted,
  updateProvider,
  serviceHub,
}: CloudConnectionCardProps) {
  const { t } = useTranslation()
  const [keyDraft, setKeyDraft] = useState('')

  // Reset the draft whenever the selection changes, so a key typed for one
  // provider can never be saved onto another.
  useEffect(() => {
    setKeyDraft(selected?.api_key ?? '')
  }, [selected?.provider, selected?.api_key])

  const localApiServerUrl = useMemo(() => getLocalApiServerUrl(), [])

  const apiKeySetting = selected?.settings.find((s) => s.key === 'api-key')
  const baseUrlSetting = selected?.settings.find((s) => s.key === 'base-url')
  const needsKey = selected ? takesApiKey(selected) : false
  const connected = selected ? isProviderConnected(selected) : false
  // Disconnecting means deleting the key, so it is only offered when a key is
  // what makes this provider work. Ollama declares an optional `api-key`
  // setting but is reachable without one, and clearing an empty key would be a
  // no-op button that claims to disconnect something.
  const hasKey = Boolean(selected?.api_key?.trim())

  const handleSaveKey = () => {
    if (!selected) return
    const apiKey = keyDraft.trim()
    if (!apiKey) return

    saveProviderApiKey({
      provider: selected,
      apiKey,
      duringOnboarding: isOnboardingPending(providers),
      updateProvider,
      serviceHub,
    })
    toast.success(
      t('cloud:connection.saved', {
        provider: getProviderTitle(selected.provider),
      })
    )
  }

  const handleDisconnect = () => {
    if (!selected) return
    updateProvider(selected.provider, buildApiKeyUpdate(selected, ''))
    setKeyDraft('')
    toast.success(
      t('cloud:connection.removed', {
        provider: getProviderTitle(selected.provider),
      })
    )
  }

  const handleBaseUrlChange = (value: string) => {
    if (!selected) return
    const update = buildBaseUrlUpdate(selected, value)
    updateProvider(selected.provider, update)
    void Promise.resolve(
      serviceHub.providers().updateSettings(selected.provider, update.settings)
    ).catch((error) => {
      console.warn('[cloud] updateSettings failed:', error)
    })
  }

  return (
    <Card
      header={
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="font-studio text-base font-medium text-foreground">
              {t('cloud:connection.title')}
            </h2>
            <p className="text-muted-foreground">
              {t('cloud:connection.description')}
            </p>
          </div>
          <CloudProviderSelect
            providers={providers}
            selected={selected}
            onSelect={onSelect}
            onAddCustom={onAddCustom}
          />
        </div>
      }
    >
      {!selected ? (
        <p className="py-2 text-muted-foreground">
          {providers.length === 0
            ? t('cloud:connection.empty')
            : t('cloud:connection.placeholder')}
        </p>
      ) : (
        <>
          <CardItem
            title={
              <span className="flex items-center gap-2">
                {connected ? (
                  <span
                    data-testid="cloud-connection-status-dot"
                    className="size-2 shrink-0 rounded-full bg-green-500"
                  />
                ) : (
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                )}
                {connected
                  ? t('cloud:connection.connected')
                  : t('cloud:connection.notConnected')}
              </span>
            }
            description={
              <>
                {isKeylessRemoteProvider(selected) && (
                  <span className="block">
                    {t('cloud:connection.keyless')}
                  </span>
                )}
                <span className="block">
                  {t('cloud:connection.routing', {
                    baseUrl: localApiServerUrl,
                  })}
                </span>
              </>
            }
            align="start"
            actions={
              hasKey ? (
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      {t('cloud:connection.disconnect')}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>
                        {t('cloud:connection.disconnectTitle', {
                          provider: getProviderTitle(selected.provider),
                        })}
                      </DialogTitle>
                      <DialogDescription>
                        {t('cloud:connection.disconnectDescription')}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="mt-2">
                      <DialogClose asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="hover:no-underline"
                        >
                          {t('cloud:connection.cancel')}
                        </Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleDisconnect}
                        >
                          {t('cloud:connection.disconnect')}
                        </Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              ) : undefined
            }
          />

          {needsKey && (
            <CardItem
              title={t('cloud:connection.apiKey')}
              column
              description={
                apiKeySetting?.description ? (
                  <RenderMarkdown
                    className="![>p]:text-muted-foreground select-none"
                    content={apiKeySetting.description}
                    components={{
                      a: ({ style, ...props }) => (
                        <a
                          {...props}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#1F7CFF', ...style }}
                        />
                      ),
                    }}
                  />
                ) : undefined
              }
              actions={
                <div className="mt-2 flex w-full items-center gap-2">
                  <InputControl
                    type="password"
                    className="w-full"
                    value={keyDraft}
                    placeholder={
                      (apiKeySetting?.controller_props?.placeholder as
                        | string
                        | undefined) ?? t('cloud:connection.apiKeyPlaceholder')
                    }
                    inputActions={['unobscure', 'copy']}
                    onChange={setKeyDraft}
                  />
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={!keyDraft.trim() || keyDraft === selected.api_key}
                    onClick={handleSaveKey}
                  >
                    {hasKey
                      ? t('cloud:connection.save')
                      : t('cloud:connection.connect')}
                  </Button>
                </div>
              }
            />
          )}

          {baseUrlSetting && (
            <CardItem
              title={t('cloud:connection.baseUrl')}
              column
              actions={
                <div className="mt-2 w-full">
                  <InputControl
                    className="w-full"
                    value={selected.base_url ?? ''}
                    placeholder={
                      (baseUrlSetting.controller_props?.placeholder as
                        | string
                        | undefined) ?? ''
                    }
                    onChange={handleBaseUrlChange}
                  />
                </div>
              }
            />
          )}

          <DeleteProvider provider={selected} onDeleted={onDeleted} />
        </>
      )}
    </Card>
  )
}
