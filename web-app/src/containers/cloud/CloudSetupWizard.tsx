import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronLeft, Cloud } from 'lucide-react'

import { Button } from '@/components/ui/button'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { listedModels } from '@/lib/cloud-model-catalog'
import { isProviderConnected } from '@/lib/cloud-providers'
import { getProviderTitle } from '@/lib/utils'

/** The providers the guide offers first, in this order. */
const GUIDE_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'deepseek',
  'groq',
  'mistral',
  'xai',
  'chatgpt',
]

type CloudSetupWizardProps = {
  /** Hosted providers. */
  providers: ProviderObject[]
  selected?: ProviderObject
  onSelect: (providerName: string) => void
  onFinish: () => void
  /** The connection form for `selected`: the same cards the page shows. */
  children: ReactNode
}

/**
 * The Cloud page's first-visit guide: pick a provider, then connect it with
 * the page's own connection form. Finishing or skipping it is remembered; the
 * header's "Guide me" opens it again.
 */
export function CloudSetupWizard({
  providers,
  selected,
  onSelect,
  onFinish,
  children,
}: CloudSetupWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'choose' | 'connect'>('choose')
  const connectedCount = providers.filter(isProviderConnected).length

  const choices = useMemo(() => {
    const known = providers
      .filter((p) => GUIDE_PROVIDERS.includes(p.provider))
      .sort(
        (a, b) =>
          GUIDE_PROVIDERS.indexOf(a.provider) -
          GUIDE_PROVIDERS.indexOf(b.provider)
      )
    // A catalog without any of them still gets something to choose from.
    return known.length > 0 ? known : providers.slice(0, GUIDE_PROVIDERS.length)
  }, [providers])

  const modelsLabel = (provider: ProviderObject) => {
    const count = listedModels(provider).length
    if (count === 0) return t('cloud:guide.modelsAfterConnecting')
    if (count === 1) return t('cloud:guide.modelsAvailableOne')
    return t('cloud:guide.modelsAvailable', { count })
  }

  const selectedTitle = selected ? getProviderTitle(selected.provider) : ''

  return (
    <section
      aria-label={t('cloud:guide.label')}
      className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-start gap-3">
          <span className="shrink-0 rounded-xl bg-teal-300/10 p-3 text-teal-600 dark:text-teal-300">
            <Cloud size={22} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted-foreground">
              {step === 'choose'
                ? t('cloud:guide.stepChoose')
                : t('cloud:guide.stepConnect')}
            </p>
            <h1 className="font-studio text-xl font-semibold">
              {step === 'choose'
                ? t('cloud:guide.chooseTitle')
                : t('cloud:guide.connectTitle', { provider: selectedTitle })}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {step === 'choose'
                ? t('cloud:guide.chooseDescription')
                : t('cloud:guide.connectDescription')}
            </p>
          </div>
        </div>
        {step === 'choose' ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {choices.map((provider) => {
                const title = getProviderTitle(provider.provider)
                const connected = isProviderConnected(provider)
                return (
                  <button
                    type="button"
                    key={provider.provider}
                    aria-label={t('cloud:guide.choose', { provider: title })}
                    onClick={() => {
                      onSelect(provider.provider)
                      setStep('connect')
                    }}
                    className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-secondary"
                  >
                    <ProvidersAvatar
                      provider={provider}
                      className="size-8 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {title}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {connected
                          ? t('cloud:connection.connected')
                          : modelsLabel(provider)}
                      </span>
                    </span>
                    {connected ? (
                      <Check
                        size={16}
                        className="shrink-0 text-emerald-500"
                        aria-hidden
                      />
                    ) : (
                      <ArrowRight
                        size={16}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>
                )
              })}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 text-xs text-muted-foreground">
                {connectedCount === 0
                  ? t('cloud:guide.browseHint')
                  : connectedCount === 1
                    ? t('cloud:guide.connectedOne')
                    : t('cloud:guide.connectedCount', {
                        count: connectedCount,
                      })}
              </span>
              <Button
                variant={connectedCount > 0 ? 'default' : 'outline'}
                onClick={onFinish}
              >
                {connectedCount > 0
                  ? t('cloud:guide.done')
                  : t('cloud:guide.browse')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              className="mb-3"
              onClick={() => setStep('choose')}
            >
              <ChevronLeft size={15} aria-hidden />
              {t('cloud:guide.back')}
            </Button>
            <div className="flex flex-col gap-4">{children}</div>
            {selected && isProviderConnected(selected) && (
              <div
                role="status"
                className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Check
                    size={16}
                    className="shrink-0 text-emerald-500"
                    aria-hidden
                  />
                  {t('cloud:guide.successTitle', { provider: selectedTitle })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('cloud:guide.successHint')}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setStep('choose')}>
                    {t('cloud:guide.connectAnother')}
                  </Button>
                  <Button onClick={onFinish}>{t('cloud:guide.done')}</Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
