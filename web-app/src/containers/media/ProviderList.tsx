/**
 * Settings → Media: the configured providers.
 *
 * Follows the Settings → Providers layout (Card + CardItem + Switch) rather
 * than inventing a second visual language for the same job, per the plan's
 * Task 12 Step 3.
 *
 * The isolation the store provides is load-bearing here: health, capabilities
 * and errors are all keyed per provider, so this component renders each row's
 * own state and never a single shared error banner. One provider pointed at a
 * dead URL must not make the others look broken.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  mediaSecretKey,
  mediaSecretStorageAvailable,
  setMediaProviderSecret,
} from '@/services/media/secrets'
import { useMediaProviderStore } from '@/stores/media-provider-store'
import type {
  MediaProviderAdapterId,
  MediaProviderDescriptor,
  MediaProviderKind,
} from '@/services/media/contract'

/** Adapter choices offered when adding a provider, with readable names. */
const ADAPTER_OPTIONS: Array<{
  id: MediaProviderAdapterId
  label: string
  kind: MediaProviderKind
}> = [
  {
    id: 'atomic-media-worker',
    label: 'Radium Media Worker',
    kind: 'local_worker',
  },
  { id: 'comfyui', label: 'ComfyUI', kind: 'local_comfy' },
  { id: 'a1111', label: 'AUTOMATIC1111', kind: 'local_worker' },
  { id: 'replicate', label: 'Replicate', kind: 'remote_http' },
  { id: 'fal-ai', label: 'fal.ai', kind: 'remote_http' },
  { id: 'stability-ai', label: 'Stability AI', kind: 'remote_http' },
  {
    id: 'openai-images',
    label: 'OpenAI-compatible images',
    kind: 'remote_http',
  },
  { id: 'custom-http', label: 'Custom HTTP', kind: 'remote_http' },
]

/**
 * Which adapters take a credential, and whether they can work without one.
 *
 * Required: the service rejects every request without a key, so the provider
 * is saved pointing at its credential even when the field was left empty - it
 * then reports "no API key configured" instead of silently sending nothing.
 * Optional: a self-hosted or custom endpoint that may or may not want one.
 */
const CREDENTIAL: Partial<
  Record<
    MediaProviderAdapterId,
    { required: boolean; labelKey: string; label: string; placeholder?: string }
  >
> = {
  'openai-images': {
    required: false,
    labelKey: 'media:providers.apiKey',
    label: 'API key',
  },
  'custom-http': {
    required: false,
    labelKey: 'media:providers.apiKey',
    label: 'API key',
  },
  'replicate': {
    required: true,
    labelKey: 'media:providers.apiKey',
    label: 'API key',
  },
  'fal-ai': {
    required: true,
    labelKey: 'media:providers.apiKey',
    label: 'API key',
  },
  'stability-ai': {
    required: true,
    labelKey: 'media:providers.apiKey',
    label: 'API key',
  },
  // --api-auth is HTTP Basic, so the credential is the user:password pair.
  'a1111': {
    required: false,
    labelKey: 'media:providers.basicAuth',
    label: 'API credentials (only if started with --api-auth)',
    placeholder: 'user:password',
  },
}

/**
 * A stable id derived from the name the user typed. Ids qualify every model id
 * and key the per-provider state, so they must not change afterwards - which is
 * why this runs once at creation and the id is never recomputed from an edited
 * label.
 */
function providerIdFrom(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  )
}

const HEALTH_LABEL: Record<string, string> = {
  online: 'Online',
  offline: 'Offline',
  checking: 'Checking',
  unauthorised: 'Needs a key',
}

function HealthBadge({ state }: { state?: string }) {
  const { t } = useTranslation()
  const resolved = state ?? 'checking'
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-xs',
        resolved === 'online' && 'bg-green-500/15 text-green-600',
        resolved === 'offline' && 'bg-destructive/15 text-destructive',
        resolved === 'unauthorised' && 'bg-yellow-500/15 text-yellow-700',
        resolved === 'checking' && 'bg-muted text-muted-foreground'
      )}
    >
      {t(`media:providers.health.${resolved}`, {
        defaultValue: HEALTH_LABEL[resolved] ?? resolved,
      })}
    </span>
  )
}

export function ProviderList() {
  const { t } = useTranslation()
  const providers = useMediaProviderStore((state) => state.providers)
  const health = useMediaProviderStore((state) => state.health)
  const errors = useMediaProviderStore((state) => state.errors)
  const capabilities = useMediaProviderStore((state) => state.capabilities)
  const refreshing = useMediaProviderStore((state) => state.refreshing)
  const addProvider = useMediaProviderStore((state) => state.addProvider)
  const removeProvider = useMediaProviderStore((state) => state.removeProvider)
  const setProviderEnabled = useMediaProviderStore(
    (state) => state.setProviderEnabled
  )
  const refresh = useMediaProviderStore((state) => state.refresh)
  const refreshRegistry = useMediaProviderStore(
    (state) => state.refreshRegistry
  )
  const registryLoading = useMediaProviderStore(
    (state) => state.registryLoading
  )

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [adapter, setAdapter] = useState<MediaProviderAdapterId>(
    'atomic-media-worker'
  )
  const [apiKey, setApiKey] = useState('')

  /**
   * Whether this machine can store a credential at all. Asked BEFORE offering
   * to save one, so a user on a Linux box with no Secret Service is told up
   * front rather than finding out when a generation fails to authenticate.
   * `null` means "not answered yet".
   */
  const [canStoreSecrets, setCanStoreSecrets] = useState<boolean | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    void mediaSecretStorageAvailable().then((available) => {
      if (!cancelled) setCanStoreSecrets(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const credential = CREDENTIAL[adapter]

  const ordered = useMemo(
    () => [...providers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [providers]
  )

  const resetForm = useCallback(() => {
    setAdding(false)
    setName('')
    setBaseUrl('')
    setAdapter('atomic-media-worker')
    // Clear the field so the secret does not sit in a mounted input.
    setApiKey('')
  }, [])

  const handleSave = useCallback(() => {
    const label = name.trim()
    if (!label) return

    const id = providerIdFrom(label)
    const option = ADAPTER_OPTIONS.find((entry) => entry.id === adapter)
    const chosen = CREDENTIAL[adapter]
    const typedKey = Boolean(chosen) && apiKey.trim().length > 0
    const pointsAtKey = typedKey || chosen?.required === true

    const descriptor: MediaProviderDescriptor = {
      id,
      label,
      kind: option?.kind ?? 'remote_http',
      adapter,
      base_url: baseUrl.trim() || undefined,
      // Only ever a POINTER to the credential. The credential itself goes to
      // the secrets seam and never into this descriptor or localStorage.
      auth: pointsAtKey
        ? { type: 'api_key', setting_key: mediaSecretKey(id) }
        : { type: 'none' },
      enabled: true,
      origin: 'user',
      order: providers.length,
    }

    // The provider is added at once; only its first health check waits for
    // the credential store, so the check does not run before the key exists
    // and report "needs a key" for a key that was just typed. A store that
    // refuses is reported by the adapter as "no API key configured".
    const saved = typedKey
      ? setMediaProviderSecret(id, apiKey).catch(() => undefined)
      : Promise.resolve()
    addProvider(descriptor)
    resetForm()
    void saved.then(() => refresh({ providerId: id }))
  }, [
    adapter,
    addProvider,
    apiKey,
    baseUrl,
    name,
    providers.length,
    refresh,
    resetForm,
  ])

  const handleToggle = useCallback(
    (provider: MediaProviderDescriptor, enabled: boolean) => {
      setProviderEnabled(provider.id, enabled)
      // Capabilities are only fetched for enabled providers, so a provider the
      // user just switched on has none until this runs. Without it the studio
      // would show nothing and the switch would look like it did nothing.
      if (enabled) void refresh({ providerId: provider.id })
    },
    [refresh, setProviderEnabled]
  )

  return (
    <Card
      title={t('media:providers.cardTitle', {
        defaultValue: 'Media providers',
      })}
    >
      <CardItem
        title={t('media:providers.listTitle', {
          defaultValue: 'Configured providers',
        })}
        description={t('media:providers.listDescription', {
          defaultValue:
            'Each provider is checked on its own. One that is unreachable does not affect the others.',
        })}
        actions={
          <div className="flex gap-2">
            <Button
              variant="link"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {t('media:providers.refresh', { defaultValue: 'Refresh' })}
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => void refreshRegistry(true)}
              disabled={registryLoading}
            >
              {t('media:providers.checkForNew', {
                defaultValue: 'Check for new providers',
              })}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              {t('media:providers.add', { defaultValue: 'Add provider' })}
            </Button>
          </div>
        }
      />

      {adding && (
        <CardItem
          column
          title={t('media:providers.newProvider', {
            defaultValue: 'New provider',
          })}
          className="gap-2"
          description={
            <div className="mt-2 w-full space-y-2">
              <div className="space-y-1">
                <label htmlFor="media-provider-name">
                  {t('media:providers.name', { defaultValue: 'Name' })}
                </label>
                <Input
                  id="media-provider-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="media-provider-url">
                  {t('media:providers.baseUrl', { defaultValue: 'Base URL' })}
                </label>
                <Input
                  id="media-provider-url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="media-provider-adapter">
                  {t('media:providers.adapter', { defaultValue: 'Adapter' })}
                </label>
                <select
                  id="media-provider-adapter"
                  className="border-input h-9 w-full rounded-md border bg-transparent px-3"
                  value={adapter}
                  onChange={(event) =>
                    setAdapter(event.target.value as MediaProviderAdapterId)
                  }
                >
                  {ADAPTER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {t(`media:providers.adapters.${option.id}`, {
                        defaultValue: option.label,
                      })}
                    </option>
                  ))}
                </select>
              </div>
              {credential && (
                <div className="space-y-1">
                  <label htmlFor="media-provider-key">
                    {t(credential.labelKey, { defaultValue: credential.label })}
                  </label>
                  <Input
                    id="media-provider-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    placeholder={credential.placeholder}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  {canStoreSecrets === false && (
                    <p className="text-xs text-destructive">
                      {t('media:providers.secretUnavailable', {
                        defaultValue:
                          'This system has no credential store, so a key cannot be saved securely. On Linux this usually means no Secret Service provider is running.',
                      })}
                    </p>
                  )}
                  {canStoreSecrets === true && (
                    <p className="text-xs text-muted-foreground">
                      {t('media:providers.secretStored', {
                        defaultValue:
                          "Stored in your operating system's credential manager, never in the app's settings file.",
                      })}
                    </p>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave}>
                  {t('media:providers.save', { defaultValue: 'Save provider' })}
                </Button>
                <Button variant="link" size="sm" onClick={resetForm}>
                  {t('media:providers.cancel', { defaultValue: 'Cancel' })}
                </Button>
              </div>
            </div>
          }
        />
      )}

      {ordered.map((provider) => {
        const detail = errors[provider.id]
        const models = capabilities[provider.id]?.models.length ?? 0
        return (
          <CardItem
            key={provider.id}
            title={provider.label}
            description={
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <HealthBadge state={health[provider.id]?.state} />
                  <span>
                    {provider.base_url ??
                      t('media:providers.noUrl', { defaultValue: 'No URL' })}
                  </span>
                  <span>
                    {t('media:providers.modelCount', {
                      count: models,
                      defaultValue: 'Models: {{count}}',
                    })}
                  </span>
                </span>
                {detail && <span className="text-destructive">{detail}</span>}
              </span>
            }
            actions={
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={t('media:providers.enable', {
                    label: provider.label,
                    defaultValue: 'Enable {{label}}',
                  })}
                  checked={provider.enabled}
                  onCheckedChange={(checked) => handleToggle(provider, checked)}
                />
                {provider.origin !== 'builtin' && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => removeProvider(provider.id)}
                  >
                    {t('media:providers.remove', { defaultValue: 'Remove' })}
                  </Button>
                )}
              </div>
            }
          />
        )
      })}
    </Card>
  )
}
