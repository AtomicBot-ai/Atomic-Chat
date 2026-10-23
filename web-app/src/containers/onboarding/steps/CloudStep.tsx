import { useEffect, useState } from 'react'
import { ArrowRight, Check, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useProviderKeyConnect } from '@/hooks/useProviderKeyConnect'
import { useSubscriptionConnect } from '@/hooks/useSubscriptionConnect'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  galleryLabel,
  isProviderConnected,
  isSubscriptionProvider,
} from '@/lib/cloud-providers'
import { cn } from '@/lib/utils'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
  type ProviderKeyStatus,
} from '@/stores/provider-key-status-store'

import {
  ONBOARDING_FIRST_PICK,
  selectOnboardingCloudProviders,
  useCloudGalleryProviders,
} from './cloudAvailability'
import type { StepProps } from './types'
import '../cloud.css'

/** A provider the user has set up, and whether its key was confirmed. */
type Connection = 'connected' | 'unverified' | null

/**
 * Connected as the Cloud page counts it: a key or a signed-in account. A key
 * the provider refused in a chat is offered again instead, so it can be
 * replaced here.
 */
function connectionOf(
  provider: ModelProvider,
  statuses: Record<string, ProviderKeyStatus>
): Connection {
  if (!isProviderConnected(provider)) return null
  const keyState = keyStatusFor(provider, statuses)?.state
  if (keyState === 'rejected') return null
  return keyState === 'unverified' ? 'unverified' : 'connected'
}

type PaneProps = {
  provider: ModelProvider
  onConnected: (providerName: string) => void
  /** A key check or a browser sign-in is under way. */
  onBusy: (busy: boolean) => void
}

/** The API key form for the selected provider. */
function KeyPane({
  provider,
  done,
  onConnected,
  onBusy,
}: PaneProps & { done: boolean }) {
  const { t } = useTranslation()
  const { connect, checking, keyError, canSaveAnyway, clearKeyError } =
    useProviderKeyConnect({ duringOnboarding: true })
  const [apiKey, setApiKey] = useState('')
  const label = galleryLabel(provider.provider)
  const errorId = `ob-key-error-${provider.provider}`

  useEffect(() => onBusy(checking), [checking, onBusy])

  const save = async (saveAnyway = false) => {
    const result = await connect(provider, apiKey, saveAnyway)
    if (result.kind !== 'saved') return
    setApiKey('')
    // The selection moves on at once, so a key that could not be checked
    // says so here rather than only on its card.
    if (result.unverifiedReason !== undefined) {
      toast.warning(t('setup:cloudStep.savedUnverified', { provider: label }), {
        description: result.unverifiedReason,
      })
    }
    onConnected(result.providerName)
  }

  const placeholder =
    (provider.settings?.find((setting) => setting.key === 'api-key')
      ?.controller_props?.placeholder as string | undefined) ??
    t('onboarding-cloud:keyPlaceholder')

  return (
    <>
      <form
        className="ob-key-row"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="ob-key-field">
          <span>{t('setup:cloudStep.keyLabel')}</span>
          <input
            type="password"
            name="provider-key"
            aria-label={t('onboarding-cloud:keyFor', { provider: label })}
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={placeholder}
            disabled={checking || done}
            onChange={(event) => {
              setApiKey(event.target.value)
              clearKeyError()
            }}
          />
        </label>
        <button
          type="submit"
          className="ob-secondary"
          disabled={checking || done || !apiKey.trim()}
        >
          {checking
            ? t('onboarding-cloud:connecting')
            : done
              ? t('onboarding-cloud:connected')
              : t('setup:cloudStep.connect')}
          {done && <Check size={16} aria-hidden="true" />}
        </button>
      </form>
      {keyError && (
        <p id={errorId} role="alert" className="ob-key-error">
          {keyError}
        </p>
      )}
      {canSaveAnyway(apiKey) && (
        <button
          type="button"
          className="ob-text"
          disabled={checking}
          onClick={() => void save(true)}
        >
          {t('setup:cloudStep.saveAnyway')}
        </button>
      )}
      <p className="ob-key-note">
        <ShieldCheck size={14} aria-hidden="true" />
        {t('setup:cloudStep.keyProtected')}
      </p>
    </>
  )
}

function ConnectedNote() {
  const { t } = useTranslation()
  return (
    <p className="ob-cloud-detail ob-cloud-done">
      <Check size={16} aria-hidden="true" />
      {t('onboarding-cloud:connected')}
    </p>
  )
}

/**
 * The ChatGPT sign-in. Its own component so the backend is asked about the
 * account only once the user picks the subscription.
 */
function SubscriptionPane({ provider, onConnected, onBusy }: PaneProps) {
  const { t } = useTranslation()
  const { state, error, connect, cancel, connecting } = useSubscriptionConnect(
    provider,
    (result) => onConnected(result.providerName)
  )

  useEffect(() => onBusy(connecting), [connecting, onBusy])

  // Stays on screen when it was the last provider left to connect.
  if (state === 'connected') return <ConnectedNote />

  return (
    <>
      <p className="ob-cloud-detail">
        {t('setup:cloudStep.subscriptionDescription')}
      </p>
      {/* The backend's own message is the actionable one (port busy,
          cancelled, rejected), as in the Add provider dialog. */}
      {(error || connecting) && (
        <p
          className={error ? 'ob-key-error' : 'ob-key-note'}
          role={error ? 'alert' : 'status'}
        >
          {error ?? t('setup:cloudStep.subscriptionWaiting')}
        </p>
      )}
      <div className="ob-key-row">
        {connecting ? (
          <button
            type="button"
            className="ob-secondary"
            onClick={() => void cancel()}
          >
            {t('common:cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="ob-secondary"
            disabled={state === 'loading' || state === 'unavailable'}
            onClick={() => void connect()}
          >
            {t('setup:cloudStep.subscriptionConnect')}
          </button>
        )}
      </div>
      <p className="ob-key-note">
        <ShieldCheck size={14} aria-hidden="true" />
        {t('setup:cloudStep.subscriptionProtected')}
      </p>
    </>
  )
}

/**
 * "Your cloud models, too.": every cloud provider the app can connect from
 * here, in the step's order (`cloudAvailability`), with the selected one's key form
 * or sign-in underneath. Each connection is checked as the Add provider
 * dialog checks it; the selection then moves on to the next provider not yet
 * connected. The local download carries on above meanwhile.
 */
export function CloudStep({ next }: StepProps) {
  const { t } = useTranslation()
  const gallery = useCloudGalleryProviders()
  const statuses = useProviderKeyStatusStore((state) => state.statuses)
  const connectedInRun = useOnboardingStore((state) => state.clouds.length > 0)
  const [busy, setBusy] = useState(false)

  // Connected before the step came up: shown as such, never counted as
  // connected in this run.
  const [connectedBefore] = useState(
    () =>
      new Set(
        gallery
          .filter((provider) => connectionOf(provider, statuses))
          .map((provider) => provider.provider)
      )
  )
  // Held rather than derived, so the selection stays put while a sign-in
  // writes its models and the provider turns connected under it.
  // OpenRouter first, as the prototype opens; else the first one still open.
  const [picked, setPicked] = useState(() => {
    const open = gallery.filter(
      (provider) => !connectedBefore.has(provider.provider)
    )
    return (
      open.find((provider) => provider.provider === ONBOARDING_FIRST_PICK)
        ?.provider ??
      open[0]?.provider ??
      null
    )
  })
  const selected =
    gallery.find((provider) => provider.provider === picked) ?? gallery[0]
  const selectedConnection = selected ? connectionOf(selected, statuses) : null

  const connected = (providerName: string) => {
    setBusy(false)
    useOnboardingStore.getState().connectCloud(providerName)
    // Read the stores again: this render's lists predate the key just saved.
    const providers = selectOnboardingCloudProviders(
      useModelProvider.getState().providers
    )
    const latest = useProviderKeyStatusStore.getState().statuses
    const at = providers.findIndex(
      (provider) => provider.provider === providerName
    )
    const following = [...providers.slice(at + 1), ...providers.slice(0, at)]
    const nextOpen = following.find(
      (provider) =>
        provider.provider !== providerName && !connectionOf(provider, latest)
    )
    setPicked(nextOpen?.provider ?? providerName)
  }

  const pane = () => {
    if (!selected) return null
    if (!isSubscriptionProvider(selected.provider)) {
      return (
        <KeyPane
          key={selected.provider}
          provider={selected}
          done={selectedConnection !== null}
          onConnected={connected}
          onBusy={setBusy}
        />
      )
    }
    // Signed in before the step: mounting the sign-in would report it as
    // connected in this run.
    if (connectedBefore.has(selected.provider)) return <ConnectedNote />
    return (
      <SubscriptionPane
        key={selected.provider}
        provider={selected}
        onConnected={connected}
        onBusy={setBusy}
      />
    )
  }

  return (
    <div className="ob-cloud">
      <h1 tabIndex={-1}>{t('onboarding-cloud:title')}</h1>
      <p className="ob-lead">{t('onboarding-cloud:lead')}</p>
      <div className="ob-cloud-catalog">
        <div
          className="ob-cloud-options"
          role="group"
          aria-label={t('onboarding-cloud:providers')}
        >
          {gallery.map((provider) => {
            const connection = connectionOf(provider, statuses)
            const label = galleryLabel(provider.provider)
            const isSelected = provider.provider === selected?.provider
            return (
              <button
                key={provider.provider}
                type="button"
                aria-label={label}
                aria-pressed={isSelected}
                aria-description={
                  connection === 'unverified'
                    ? t('onboarding-cloud:notVerified')
                    : connection
                      ? t('onboarding-cloud:connected')
                      : undefined
                }
                disabled={busy || connection !== null}
                className={cn(
                  connection ? 'connected' : isSelected && 'selected'
                )}
                onClick={() => setPicked(provider.provider)}
              >
                <ProvidersAvatar
                  provider={provider}
                  className="size-6 shrink-0"
                />
                <span className="ob-provider-name" title={label}>
                  {label}
                </span>
                {connection === 'unverified' && (
                  <small className="ob-provider-status">
                    {t('onboarding-cloud:notVerified')}
                  </small>
                )}
                {connection && <Check size={15} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      </div>
      {selected && (
        <section className="ob-cloud-connect" aria-labelledby="ob-cloud-name">
          <div className="ob-cloud-heading">
            <ProvidersAvatar provider={selected} className="size-6 shrink-0" />
            <h2 id="ob-cloud-name">{galleryLabel(selected.provider)}</h2>
          </div>
          {pane()}
        </section>
      )}
      <div className="ob-actions">
        <button
          type="button"
          className="ob-primary"
          onClick={() => next(connectedInRun ? 'continue' : 'skip')}
        >
          {connectedInRun
            ? t('onboarding:continue')
            : t('onboarding-cloud:skip')}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
