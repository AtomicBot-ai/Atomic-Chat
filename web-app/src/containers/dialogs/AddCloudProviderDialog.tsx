import { useMemo, useState } from 'react'
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
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { saveProviderApiKey } from '@/lib/provider-api-key'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  isLocalProvider,
  isLoopbackUrl,
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
 * The cloud providers worth offering during onboarding: everything that takes
 * an API key and talks to somebody else's server.
 *
 * Sourced from the live provider list rather than the remote registry, because
 * `updateProvider` silently no-ops on a name that is not already in that list —
 * so offering a card the store has never heard of would save nothing, with no
 * error anywhere.
 *
 * Order is the registry's own (flagship-first), deliberately not sorted.
 */
export function selectCloudGalleryProviders(
  providers: ModelProvider[]
): ModelProvider[] {
  return providers.filter(
    (p) =>
      !isLocalProvider(p.provider) &&
      // Catches `ollama` and any future LM-Studio-style entry without
      // hardcoding an id: a loopback base URL means the "cloud" is this machine.
      !isLoopbackUrl(p.base_url) &&
      !p.persist &&
      !KEY_ONLY_UNSUPPORTED.has(p.provider) &&
      p.settings?.some((s) => s.key === 'api-key')
  )
}

type Step = { name: 'gallery' } | { name: 'key'; provider: ModelProvider }

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
 * Two-step "connect a cloud provider" flow: pick a provider, paste its key.
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

    onKeySaved({
      providerName: step.provider.provider,
      modelId: step.provider.models?.[0]?.id ?? null,
    })
    reset()
    onOpenChange(false)

    // Saving is synchronous and the dialog closes immediately, so without this
    // the only feedback is the screen changing underneath you. Fired last and
    // guarded — confirmation is cosmetic and must never strand a saved key.
    try {
      toast.success(
        t('setup:cloudStep.saved', {
          provider: getProviderTitle(step.provider.provider),
        })
      )
    } catch (error) {
      console.debug('[AddCloudProviderDialog] success toast failed', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
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
                      onClick={() => setStep({ name: 'key', provider })}
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
                          {getProviderTitle(provider.provider)}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {/* The i18n layer does plain {{var}} interpolation
                              with no plural support, so the two forms are
                              separate keys — same as `localStep.titleOne`. */}
                          {modelCount === 0
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
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('setup:cloudStep.keyTitle', {
                  provider: getProviderTitle(step.provider.provider),
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
                {getProviderTitle(step.provider.provider)}
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
