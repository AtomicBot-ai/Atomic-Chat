import { useEffect, useMemo, useState } from 'react'
import { IconExternalLink, IconLoader2 } from '@tabler/icons-react'
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
import { useConnectMediaServer } from '@/hooks/useConnectMediaServer'
import { isMediaConnected } from '@/lib/media-models'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isProviderConnected,
  isSubscriptionProvider,
  takesApiKey,
} from '@/lib/cloud-providers'
import { isOnboardingPending } from '@/lib/onboarding'
import { buildApiKeyUpdate, saveProviderApiKey } from '@/lib/provider-api-key'
import { buildBaseUrlUpdate } from '@/lib/provider-base-url'
import {
  checkProviderKey,
  recordKeyCheck,
  savedAnyway,
  type KeyCheckOutcome,
} from '@/lib/provider-key-check'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  useProviderKeyStatus,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'
import { isKeylessRemoteProvider } from '@/utils/registerRemoteProvider'
import type { ServiceHub } from '@/services'

type CloudConnectionCardProps = {
  /**
   * The Cloud page picks the provider in its own list, so the card drops its
   * dropdown and titles itself with the provider instead.
   */
  hideProviderSelect?: boolean
  providers: ProviderObject[]
  selected: ProviderObject | undefined
  onSelect: (providerName: string) => void
  onAddCustom?: () => void
  onDeleted: () => void
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  serviceHub: Pick<ServiceHub, 'providers'>
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
  hideProviderSelect = false,
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
  // A key is checked with the provider before it is saved: `checking` while
  // that request runs, `keyError` when the provider refused the key.
  const [checking, setChecking] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  // The key the provider called invalid, which the user may save anyway: a
  // gateway can refuse its model list to a key that chats fine.
  const [refusedKey, setRefusedKey] = useState<string | null>(null)
  const keyStatus = useProviderKeyStatus(selected)
  const { connecting: connectingMedia, connect: connectMediaServer } =
    useConnectMediaServer(updateProvider)

  // Reset the draft whenever the selection changes, so a key typed for one
  // provider can never be saved onto another.
  useEffect(() => {
    setKeyDraft(selected?.api_key ?? '')
    setKeyError(null)
    setRefusedKey(null)
  }, [selected?.provider, selected?.api_key])

  const localApiServerUrl = useMemo(() => getLocalApiServerUrl(), [])

  // A subscription is connected by signing in, not by a key or a base URL, so
  // its own card owns the whole body. Rendering the status line here too would
  // show a second, always-"not connected" state for the same provider.
  const isSubscription = isSubscriptionProvider(selected?.provider)

  const apiKeySetting = selected?.settings.find((s) => s.key === 'api-key')
  const baseUrlSetting = selected?.settings.find((s) => s.key === 'base-url')
  const needsKey = selected ? takesApiKey(selected) : false
  // A server that only makes media is connected once its media models are set up.
  const connected = selected
    ? isProviderConnected(selected) || isMediaConnected(selected)
    : false
  // Disconnecting means deleting the key, so it is only offered when a key is
  // what makes this provider work. Ollama declares an optional `api-key`
  // setting but is reachable without one, and clearing an empty key would be a
  // no-op button that claims to disconnect something.
  const hasKey = Boolean(selected?.api_key?.trim())
  // A saved key the provider refused, or one it could not be asked about,
  // is not "Connected".
  const keyState = connected ? keyStatus?.state : undefined
  // A server that only makes media (Automatic1111, stable-diffusion.cpp) has no chat models to
  // reload and needs no key: it is connected from its address, by asking it for its models.
  const mediaServer = selected?.media_only === true

  /**
   * What to tell the user when a check refused the key: a line of ours, then
   * the provider's own reason.
   */
  const refusalText = (
    outcome: Extract<KeyCheckOutcome, { kind: 'refused' }>,
    providerName: string
  ) =>
    outcome.reason === 'ownServer'
      ? t('cloud:connection.ownServer', { url: outcome.serverUrl ?? '' })
      : [
          t('cloud:connection.keyRejected', {
            provider: getProviderTitle(providerName),
          }),
          outcome.message,
        ]
          .filter(Boolean)
          .join(' ')

  /** Check the typed key, then save it; `saveAnyway` saves one it refused. */
  const handleSaveKey = async (saveAnyway = false) => {
    if (!selected || checking) return
    const provider = selected
    const apiKey = keyDraft.trim()
    if (!apiKey) return
    const title = getProviderTitle(provider.provider)

    // A media server lists no chat models to ask with the key; it connects
    // from its address, as before.
    let outcome: KeyCheckOutcome | undefined
    if (saveAnyway && keyError && refusedKey === apiKey) {
      outcome = savedAnyway(keyError)
    } else if (!mediaServer) {
      setKeyError(null)
      setRefusedKey(null)
      setChecking(true)
      try {
        outcome = await checkProviderKey(provider, apiKey, serviceHub)
      } finally {
        setChecking(false)
      }
      if (outcome.kind === 'refused') {
        setKeyError(refusalText(outcome, provider.provider))
        if (outcome.reason === 'key') setRefusedKey(apiKey)
        return
      }
    }
    setKeyError(null)
    setRefusedKey(null)

    saveProviderApiKey({
      provider,
      apiKey,
      duringOnboarding: isOnboardingPending(providers),
      updateProvider,
      serviceHub,
    })
    if (outcome) recordKeyCheck(provider.provider, apiKey, outcome)
    if (outcome?.kind === 'unverified') {
      toast.warning(
        t('cloud:connection.savedUnverified', { provider: title }),
        {
          description: outcome.message,
        }
      )
    } else {
      toast.success(t('cloud:connection.saved', { provider: title }))
    }
  }

  /** Ask the provider again about the key it already has. */
  const handleCheckAgain = async () => {
    const apiKey = selected?.api_key?.trim()
    if (!selected || !apiKey || checking) return
    const provider = selected
    const title = getProviderTitle(provider.provider)
    setChecking(true)
    let outcome: KeyCheckOutcome
    try {
      outcome = await checkProviderKey(provider, apiKey, serviceHub)
    } finally {
      setChecking(false)
    }
    if (outcome.kind === 'refused') {
      const reason = refusalText(outcome, provider.provider)
      useProviderKeyStatusStore
        .getState()
        .setStatus(provider.provider, apiKey, 'rejected', reason)
      toast.error(reason)
      return
    }
    recordKeyCheck(provider.provider, apiKey, outcome)
    if (outcome.kind === 'verified') {
      toast.success(t('cloud:connection.saved', { provider: title }))
    } else {
      toast.warning(
        t('cloud:connection.savedUnverified', { provider: title }),
        {
          description: outcome.message,
        }
      )
    }
  }

  const handleDisconnect = () => {
    if (!selected) return
    updateProvider(selected.provider, buildApiKeyUpdate(selected, ''))
    useProviderKeyStatusStore.getState().clear(selected.provider)
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

  // Titled with the provider, the card says something about that provider or
  // nothing: the generic "OpenAI, Anthropic, or a compatible endpoint" read as
  // the subtitle of OpenAI and of the ChatGPT subscription alike. What the
  // catalogue knows of each is where its models are listed.
  const providerTitle =
    hideProviderSelect && selected
      ? getProviderTitle(selected.provider)
      : undefined
  const exploreModelsUrl = selected?.explore_models_url

  return (
    <Card
      header={
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="font-studio text-base font-medium text-foreground">
              {providerTitle ?? t('cloud:connection.title')}
            </h2>
            {providerTitle === undefined ? (
              <p className="text-muted-foreground">
                {t('cloud:connection.description')}
              </p>
            ) : (
              exploreModelsUrl && (
                <a
                  href={exploreModelsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t('providers:addModel.exploreModels', {
                    provider: providerTitle,
                  })}
                  <IconExternalLink size={12} className="shrink-0" />
                </a>
              )
            )}
          </div>
          {!hideProviderSelect && (
            <CloudProviderSelect
              providers={providers}
              selected={selected}
              onSelect={onSelect}
              onAddCustom={onAddCustom ?? (() => {})}
            />
          )}
        </div>
      }
    >
      {!selected ? (
        <p className="py-2 text-muted-foreground">
          {providers.length === 0
            ? t('cloud:connection.empty')
            : t('cloud:connection.placeholder')}
        </p>
      ) : isSubscription ? null : (
        <>
          <CardItem
            title={
              <span className="flex items-center gap-2">
                {connected && keyState ? (
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      keyState === 'rejected'
                        ? 'bg-destructive'
                        : 'bg-amber-500'
                    )}
                  />
                ) : connected ? (
                  <span
                    data-testid="cloud-connection-status-dot"
                    className="size-2 shrink-0 rounded-full bg-green-500"
                  />
                ) : (
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                )}
                {keyState === 'rejected'
                  ? t('cloud:connection.rejected')
                  : keyState === 'unverified'
                    ? t('cloud:connection.unverified')
                    : connected
                      ? t('cloud:connection.connected')
                      : t('cloud:connection.notConnected')}
              </span>
            }
            description={
              <>
                {keyState && keyStatus && (
                  <span
                    data-testid="cloud-key-status"
                    className={cn(
                      'block break-words',
                      keyState === 'rejected' && 'text-destructive'
                    )}
                  >
                    {keyState === 'rejected'
                      ? t('cloud:connection.rejectedHint', {
                          provider: getProviderTitle(selected.provider),
                        })
                      : t('cloud:connection.unverifiedHint', {
                          provider: getProviderTitle(selected.provider),
                        })}
                    {keyStatus.message && ` ${keyStatus.message}`}
                  </span>
                )}
                {isKeylessRemoteProvider(selected) && (
                  <span className="block">{t('cloud:connection.keyless')}</span>
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
                <div className="flex items-center gap-2">
                  {keyState && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checking}
                      onClick={() => void handleCheckAgain()}
                    >
                      {checking && (
                        <IconLoader2 size={14} className="animate-spin" />
                      )}
                      {t('cloud:connection.checkAgain')}
                    </Button>
                  )}
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
                </div>
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
                <div className="mt-2 w-full">
                  <div className="flex w-full items-center gap-2">
                    <InputControl
                      type="password"
                      className="w-full"
                      value={keyDraft}
                      placeholder={
                        (apiKeySetting?.controller_props?.placeholder as
                          | string
                          | undefined) ??
                        t('cloud:connection.apiKeyPlaceholder')
                      }
                      inputActions={['unobscure', 'copy']}
                      onChange={(value) => {
                        setKeyDraft(value)
                        setKeyError(null)
                        setRefusedKey(null)
                      }}
                    />
                    <Button
                      size="sm"
                      className="shrink-0"
                      disabled={
                        checking ||
                        !keyDraft.trim() ||
                        keyDraft === selected.api_key
                      }
                      onClick={() => void handleSaveKey()}
                    >
                      {checking && (
                        <IconLoader2 size={14} className="animate-spin" />
                      )}
                      {/* A media server's key is optional; it connects from its address. */}
                      {checking
                        ? t('cloud:connection.checking')
                        : hasKey || mediaServer
                          ? t('cloud:connection.save')
                          : t('cloud:connection.connect')}
                    </Button>
                  </div>
                  {keyError && (
                    <p
                      role="alert"
                      className="mt-2 text-sm break-words text-destructive"
                    >
                      {keyError}
                    </p>
                  )}
                  {keyError && refusedKey === keyDraft.trim() && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={checking}
                      onClick={() => void handleSaveKey(true)}
                    >
                      {t('cloud:connection.saveAnyway')}
                    </Button>
                  )}
                </div>
              }
            />
          )}

          {baseUrlSetting && (
            <CardItem
              title={t('cloud:connection.baseUrl')}
              column
              actions={
                <div className="mt-2 flex w-full items-center gap-2">
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
                  {mediaServer && (
                    <Button
                      size="sm"
                      className="shrink-0"
                      variant={connected ? 'secondary' : 'default'}
                      disabled={connectingMedia || !selected.base_url?.trim()}
                      onClick={() => void connectMediaServer(selected)}
                      data-testid="cloud-media-server-connect"
                    >
                      {connectingMedia && (
                        <IconLoader2 size={14} className="animate-spin" />
                      )}
                      {connected
                        ? t('cloud:models.reload')
                        : t('cloud:connection.connect')}
                    </Button>
                  )}
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
