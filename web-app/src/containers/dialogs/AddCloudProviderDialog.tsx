import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
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
import { useChatGptAuth } from '@/hooks/useChatGptAuth'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { saveProviderApiKey } from '@/lib/provider-api-key'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  isLocalProvider,
  isLoopbackUrl,
  isSubscriptionProvider,
} from '@/utils/registerRemoteProvider'

/**
 * Providers that ship in the list but cannot be configured from a key alone.
 * Azure's `base_url` is the literal placeholder
 * `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1` — every account has
 * its own resource host, so a key-only save produces a provider that looks
 * connected and fails on first request.
 */
const KEY_ONLY_UNSUPPORTED = new Set(['azure'])

/**
 * A provider you sign into rather than paste a key for — and only where that
 * sign-in can actually happen. The OAuth callback is served by the desktop
 * backend, so on web and mobile the card would offer a button that cannot work.
 */
function isGallerySubscription(providerName: string): boolean {
  return (
    isSubscriptionProvider(providerName) &&
    PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION]
  )
}

/**
 * Names `getProviderTitle` spells out too long for a one-line card.
 *
 * The subscription's full title is "ChatGPT subscription (Codex)", which the
 * half-width card truncates mid-word; the line underneath already says it is a
 * sign-in, so the card carries the brand alone.
 */
const GALLERY_LABELS: Record<string, string> = { chatgpt: 'ChatGPT (Codex)' }

function galleryLabel(providerName: string): string {
  return GALLERY_LABELS[providerName] ?? getProviderTitle(providerName)
}

/**
 * The cloud providers worth offering during onboarding: everything that talks
 * to somebody else's server and can be connected from this dialog.
 *
 * Sourced from the live provider list rather than the remote registry, because
 * `updateProvider` silently no-ops on a name that is not already in that list —
 * so offering a card the store has never heard of would save nothing, with no
 * error anywhere.
 *
 * Order is the registry's own (flagship-first), deliberately not sorted, with
 * subscriptions lifted to the front.
 */
export function selectCloudGalleryProviders(
  providers: ModelProvider[]
): ModelProvider[] {
  const offered = providers.filter(
    (p) =>
      !isLocalProvider(p.provider) &&
      // Catches `ollama` and any future LM-Studio-style entry without
      // hardcoding an id: a loopback base URL means the "cloud" is this machine.
      !isLoopbackUrl(p.base_url) &&
      !p.persist &&
      !KEY_ONLY_UNSUPPORTED.has(p.provider) &&
      // A subscription declares no `api-key` setting by design — its bearer
      // token lives in the Rust backend — so it has to qualify on its own.
      (isGallerySubscription(p.provider) ||
        p.settings?.some((s) => s.key === 'api-key'))
  )

  // Subscriptions first. Signing in is the shortest way out of onboarding —
  // there is no dashboard to go and find a key on — yet `BASELINE_PROVIDERS` is
  // seeded after everything the registry carries, so the one provider that
  // needs nothing but a click would otherwise be the one to scroll for.
  const subscriptions = offered.filter((p) =>
    isSubscriptionProvider(p.provider)
  )
  if (subscriptions.length === 0) return offered
  return [
    ...subscriptions,
    ...offered.filter((p) => !isSubscriptionProvider(p.provider)),
  ]
}

type Step =
  | { name: 'gallery' }
  | { name: 'key'; provider: ModelProvider }
  | { name: 'subscription'; provider: ModelProvider }

export type CloudProviderSaveResult = {
  providerName: string
  /** `null` when the provider ships no models — caller must not pick one. */
  modelId: string | null
}

type AddCloudProviderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired once the key is persisted. */
  onKeySaved: (result: CloudProviderSaveResult) => void
}

/**
 * The sign-in step for a subscription provider.
 *
 * Its own component so `useChatGptAuth` — which asks the backend for the
 * connection status as soon as it mounts — runs when the user asks for this
 * provider rather than on every onboarding render: the dialog itself stays
 * mounted the whole time, open or not.
 */
function SubscriptionStep({
  provider,
  onBack,
  onConnected,
}: {
  provider: ModelProvider
  onBack: () => void
  onConnected: (result: CloudProviderSaveResult) => void
}) {
  const { t } = useTranslation()
  const { state, error, connect, cancel } = useChatGptAuth()

  // Held in a ref so the effect below depends on the connection state alone.
  // The callback is rebuilt on every parent render, and re-running the exit for
  // that would navigate out of onboarding twice.
  const onConnectedRef = useRef(onConnected)
  useEffect(() => {
    onConnectedRef.current = onConnected
  }, [onConnected])
  const finished = useRef(false)

  // Driven off the state rather than off `connect()` resolving: a session
  // signed in before onboarding started reports `connected` on the first status
  // read, and that user has as little left to do as the one who just signed in.
  useEffect(() => {
    if (state !== 'connected' || finished.current) return
    finished.current = true
    // The sign-in writes the account's catalogue onto the provider before it
    // reports connected, so the current model list is the store's — not the
    // `provider` object this step was opened with.
    const models = useModelProvider
      .getState()
      .getProviderByName(provider.provider)?.models
    onConnectedRef.current({
      providerName: provider.provider,
      modelId: models?.[0]?.id ?? null,
    })
  }, [provider.provider, state])

  const connecting = state === 'connecting'
  const label = galleryLabel(provider.provider)

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('setup:cloudStep.keyTitle', { provider: label })}
        </DialogTitle>
        <DialogDescription>
          {t('setup:cloudStep.subscriptionDescription')}
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3">
        <ProvidersAvatar provider={provider} className="size-8 shrink-0" />
        <span className="truncate text-sm font-medium">{label}</span>
      </div>

      <div className="flex flex-col gap-2">
        {/* The backend's own message is the actionable one (port busy,
            cancelled, rejected) — surfaced verbatim, as on the Cloud page. */}
        {(error || connecting) && (
          <p
            className={cn(
              'text-xs',
              error ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {error ?? t('setup:cloudStep.subscriptionWaiting')}
          </p>
        )}
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <ShieldCheck className="size-3.5 shrink-0" />
          {t('setup:cloudStep.subscriptionProtected')}
        </p>
      </div>

      <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="link"
          size="sm"
          className="w-full hover:no-underline sm:w-auto"
          onClick={onBack}
        >
          {t('common:back')}
        </Button>
        {connecting ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => void cancel()}
          >
            {t('common:cancel')}
          </Button>
        ) : (
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={state === 'loading' || state === 'unavailable'}
            onClick={() => void connect()}
          >
            {t('setup:cloudStep.subscriptionConnect')}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

/**
 * Two-step "connect a cloud provider" flow: pick a provider, then paste its key
 * or sign in.
 *
 * One `Dialog` with internal step state rather than two components, so focus
 * management, the overlay and Escape handling stay in one place and the parent
 * has a single `open` boolean to drive (onboarding's auto-exit timer depends on
 * knowing whether this is open).
 */
export function AddCloudProviderDialog({
  open,
  onOpenChange,
  onKeySaved,
}: AddCloudProviderDialogProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  // Destructured rather than selector-based, matching how the rest of the app
  // consumes this store (see SetupScreen).
  const { providers, updateProvider } = useModelProvider()

  const [step, setStep] = useState<Step>({ name: 'gallery' })
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)

  const cloudProviders = useMemo(
    () => selectCloudGalleryProviders(providers),
    [providers]
  )

  const reset = () => {
    setStep({ name: 'gallery' })
    setApiKey('')
    setRevealed(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  /**
   * The tail both paths share: hand the connected provider to onboarding, then
   * close. Fired last and guarded — the confirmation is cosmetic and must never
   * strand a connection that was actually made.
   */
  const finishWith = (result: CloudProviderSaveResult) => {
    onKeySaved(result)
    reset()
    onOpenChange(false)

    // Connecting is over in a moment and the dialog closes at once, so without
    // this the only feedback is the screen changing underneath you.
    try {
      toast.success(
        t('setup:cloudStep.saved', {
          provider: galleryLabel(result.providerName),
        })
      )
    } catch (error) {
      console.debug('[AddCloudProviderDialog] success toast failed', error)
    }
  }

  const handleSave = () => {
    if (step.name !== 'key') return
    const key = apiKey.trim()
    if (!key) return

    try {
      saveProviderApiKey({
        provider: step.provider,
        apiKey: key,
        duringOnboarding: true,
        updateProvider,
        serviceHub,
      })
    } catch (error) {
      // Keep the dialog open — closing here would strand the user back on the
      // picker with no key saved and no explanation.
      console.error('[AddCloudProviderDialog] failed to save key', error)
      toast.error(t('setup:cloudStep.saveFailed'))
      return
    }

    finishWith({
      providerName: step.provider.provider,
      modelId: step.provider.models?.[0]?.id ?? null,
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg lg:max-w-lg xl:max-w-lg">
        {step.name === 'gallery' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('setup:cloudStep.galleryTitle')}</DialogTitle>
              <DialogDescription>
                {t('setup:cloudStep.galleryDescription')}
              </DialogDescription>
            </DialogHeader>

            {cloudProviders.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t('setup:cloudStep.empty')}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {cloudProviders.map((provider) => {
                  const modelCount = provider.models?.length ?? 0
                  return (
                    <button
                      key={provider.provider}
                      type="button"
                      onClick={() =>
                        isGallerySubscription(provider.provider)
                          ? setStep({ name: 'subscription', provider })
                          : setStep({ name: 'key', provider })
                      }
                      className={cn(
                        'flex items-center gap-3 rounded-lg border bg-secondary/50 p-3 text-left',
                        'hover:bg-secondary focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none'
                      )}
                    >
                      <ProvidersAvatar
                        provider={provider}
                        className="size-8 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-tight">
                          {galleryLabel(provider.provider)}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {/* A subscription lists no models until it is signed
                              into, so a count here would read "no models" for
                              the one provider that ships plenty. */}
                          {/* The i18n layer does plain {{var}} interpolation
                              with no plural support, so the two forms are
                              separate keys — same as `localStep.titleOne`. */}
                          {isGallerySubscription(provider.provider)
                            ? t('setup:cloudStep.subscriptionOnly')
                            : modelCount === 0
                              ? t('setup:cloudStep.keyOnly')
                              : modelCount === 1
                                ? t('setup:cloudStep.modelCountOne')
                                : t('setup:cloudStep.modelCountOther', {
                                    count: modelCount,
                                  })}
                        </span>
                      </div>
                      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                    </button>
                  )
                })}
              </div>
            )}
          </>
        ) : step.name === 'subscription' ? (
          <SubscriptionStep
            provider={step.provider}
            onBack={reset}
            onConnected={finishWith}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('setup:cloudStep.keyTitle', {
                  provider: galleryLabel(step.provider.provider),
                })}
              </DialogTitle>
              <DialogDescription>
                {t('setup:cloudStep.keyDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3">
              <ProvidersAvatar
                provider={step.provider}
                className="size-8 shrink-0"
              />
              <span className="truncate text-sm font-medium">
                {galleryLabel(step.provider.provider)}
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <label
                htmlFor="cloud-provider-api-key"
                className="text-xs font-medium"
              >
                {t('setup:cloudStep.keyLabel')}
              </label>
              <div className="relative">
                <Input
                  id="cloud-provider-api-key"
                  autoFocus
                  type={revealed ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && apiKey.trim()) {
                      e.preventDefault()
                      handleSave()
                    }
                    // Onboarding listens for keys further up the tree.
                    e.stopPropagation()
                  }}
                  className="pr-9"
                  placeholder={
                    (step.provider.settings.find((s) => s.key === 'api-key')
                      ?.controller_props?.placeholder as string | undefined) ??
                    t('setup:cloudStep.keyPlaceholder')
                  }
                />
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={t(
                    revealed
                      ? 'setup:cloudStep.hideKey'
                      : 'setup:cloudStep.showKey'
                  )}
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-2 flex items-center"
                >
                  {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <ShieldCheck className="size-3.5 shrink-0" />
                {t('setup:cloudStep.keyProtected')}
              </p>
            </div>

            <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="link"
                size="sm"
                className="w-full hover:no-underline sm:w-auto"
                onClick={reset}
              >
                {t('common:back')}
              </Button>
              <Button
                size="sm"
                className="w-full sm:w-auto"
                disabled={!apiKey.trim()}
                onClick={handleSave}
              >
                {t('setup:cloudStep.saveKey')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
