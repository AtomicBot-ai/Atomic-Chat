import { useNavigate } from '@tanstack/react-router'
import { IconExternalLink } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import DecisionModelCard from '@/containers/DecisionModelCard'
import { ModelLogo } from '@/containers/ModelLogo'
import { HubReadme } from '@/containers/hub/HubReadme'
import { route } from '@/constants/routes'
import { useDecisionEngineReadiness } from '@/hooks/useDecisionEngineReadiness'
import { useDecisionModel } from '@/hooks/useDecisionModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DECISION_ENGINE_UI } from '@/lib/decision/engine'
import { decisionIconKey } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import {
  decisionDiskBytes,
  decisionQuantLabel,
  isNonCommercialLicense,
  type DecisionCatalogModel,
} from '@/services/decision-catalog-registry'

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2)

/**
 * The size on disk, or while the model downloads how much of it has arrived:
 * the readout takes the size's place so the row keeps its height.
 */
function DownloadSize({ model }: { model: DecisionCatalogModel }) {
  const { t } = useTranslation()
  const { downloading, currentBytes, totalBytes } = useDecisionModel(model)
  return (
    <span
      className="min-w-0 truncate whitespace-nowrap text-xs tabular-nums text-muted-foreground"
      aria-live={downloading ? 'polite' : undefined}
    >
      {downloading
        ? t('settings:decision.progress', {
            current: gb(currentBytes),
            total: gb(totalBytes),
          })
        : t('settings:decision.diskSize', {
            size: gb(decisionDiskBytes(model)),
          })}
    </span>
  )
}

export type DecisionModelDetailPanelProps = {
  model: DecisionCatalogModel | null
  className?: string
}

/**
 * The right-hand panel for a decision model, shaped like the other
 * categories': the download with its size, or — once the model is on disk —
 * the way to the provider page of the engine that runs it (llama.cpp
 * TurboQuant or llama.cpp), then the details and the repo's README at the
 * pinned revision.
 */
export function DecisionModelDetailPanel({
  model,
  className,
}: DecisionModelDetailPanelProps) {
  if (!model) return <EmptyPanel className={className} />
  return <ModelPanel model={model} className={className} />
}

function EmptyPanel({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center p-6 text-sm text-muted-foreground',
        className
      )}
    >
      {t('hub:selectModel')}
    </div>
  )
}

function ModelPanel({
  model,
  className,
}: {
  model: DecisionCatalogModel
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const readiness = useDecisionEngineReadiness(model)
  const engineName = DECISION_ENGINE_UI[model.engine].name
  const quant = decisionQuantLabel(model)

  const languages =
    model.languages === 'multilingual'
      ? t('settings:decision.multilingual')
      : model.languages.toUpperCase()

  const openProvider = () => {
    void navigate({
      to: route.settings.providers,
      params: { providerName: model.engine },
    })
  }

  return (
    <div className={cn('flex flex-col gap-4 p-6', className)}>
      <header className="flex items-start gap-3">
        <ModelLogo
          icon={decisionIconKey(model)}
          name={model.name}
          author={model.repo.split('/')[0]}
        />
        <div className="min-w-0 flex-1">
          <h1
            className="min-w-0 truncate text-xl font-semibold"
            title={model.name}
          >
            {model.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{model.repo}</p>
        </div>
        <a
          href={`https://huggingface.co/${model.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
        >
          <Button variant="outline" size="sm" className="gap-1.5">
            <IconExternalLink size={14} />
            {t('hub:openOnWeb')}
          </Button>
        </a>
      </header>

      {model.description && (
        <p className="text-sm text-muted-foreground">{model.description}</p>
      )}

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          data-testid={`decision-download-${model.id}`}
        >
          <span className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-md bg-muted/40 px-2 py-2">
            <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
              {quant ?? t('hub:cpu')}
            </span>
            <DownloadSize model={model} />
          </span>
          <span className="ml-auto flex shrink-0 items-center">
            <DecisionModelCard model={model} onOpen={openProvider} />
          </span>
        </div>
        {readiness.kind === 'needs_update' && (
          <p
            className="mt-3 text-xs text-amber-600 dark:text-amber-400"
            role="status"
          >
            {t('settings:decision.requiresEngineNotice', {
              engine: engineName,
              version: readiness.required,
            })}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <DetailCell label={t('hub:decisionEngine')}>
            {engineName}
            {model.vision ? ` · ${t('hub:decisionReadsImages')}` : ''}
          </DetailCell>
          <DetailCell label={t('hub:languages')}>{languages}</DetailCell>
          <DetailCell label={t('hub:context')}>
            {t('settings:decision.context', { tokens: model.context })}
          </DetailCell>
          {model.backbone && (
            <DetailCell label={t('hub:backbone')}>{model.backbone}</DetailCell>
          )}
          {model.params && (
            <DetailCell label={t('hub:parameters')}>{model.params}</DetailCell>
          )}
          <DetailCell label={t('hub:license')}>
            {model.license ?? '—'}
            {isNonCommercialLicense(model.license)
              ? ` · ${t('hub:licenseNonCommercial')}`
              : ''}
          </DetailCell>
        </dl>
      </section>

      <HubReadme
        url={`https://huggingface.co/${model.repo}/resolve/${model.revision}/README.md`}
      />
    </div>
  )
}

function DetailCell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-foreground">
        {children}
      </dd>
    </div>
  )
}
