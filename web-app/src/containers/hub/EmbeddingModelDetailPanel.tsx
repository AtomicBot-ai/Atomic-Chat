import { useNavigate } from '@tanstack/react-router'
import { IconExternalLink } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/containers/CopyButton'
import EmbeddingModelCard from '@/containers/EmbeddingModelCard'
import { ModelLogo } from '@/containers/ModelLogo'
import { HubReadme } from '@/containers/hub/HubReadme'
import { route } from '@/constants/routes'
import { useEmbeddingEngineReadiness } from '@/hooks/useEmbeddingEngineReadiness'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { EMBEDDING_ENGINE, EMBEDDING_ENGINE_UI } from '@/lib/embedding/engine'
import { embeddingIconKey } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import {
  embeddingDiskBytes,
  embeddingQuantLabel,
  type EmbeddingCatalogModel,
} from '@/services/embedding-catalog-registry'

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2)

export type EmbeddingModelDetailPanelProps = {
  model: EmbeddingCatalogModel | null
  className?: string
}

/**
 * The right-hand panel for an embedding model, shaped like the other
 * categories': the download with its size (projector included), or — once
 * the model is on disk — the way to the llama.cpp provider page that starts
 * it; then what goes in and comes out (inputs, vector length, context,
 * pooling), the prompts the model expects in front of each text, and the
 * repo's README at the pinned revision.
 */
export function EmbeddingModelDetailPanel({
  model,
  className,
}: EmbeddingModelDetailPanelProps) {
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
  model: EmbeddingCatalogModel
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const readiness = useEmbeddingEngineReadiness(model)

  const languages =
    model.languages === 'multilingual'
      ? t('settings:embedding.multilingual')
      : model.languages.toUpperCase()

  const openProvider = () => {
    void navigate({
      to: route.settings.providers,
      params: { providerName: EMBEDDING_ENGINE },
    })
  }

  const prompts = (['query', 'document'] as const).flatMap((kind) => {
    const text = model.prompts?.[kind]
    return text ? [{ kind, text }] : []
  })

  return (
    <div className={cn('flex flex-col gap-4 p-6', className)}>
      <header className="flex items-start gap-3">
        <ModelLogo
          icon={embeddingIconKey(model)}
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

      <p className="text-sm text-muted-foreground">{model.description}</p>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          data-testid={`embedding-download-${model.id}`}
        >
          <span className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-md bg-muted/40 px-2 py-2">
            <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
              {embeddingQuantLabel(model)}
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {t('settings:embedding.diskSize', {
                size: gb(embeddingDiskBytes(model)),
              })}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center">
            <EmbeddingModelCard model={model} onOpen={openProvider} />
          </span>
        </div>
        {readiness.kind === 'needs_update' && (
          <p
            className="mt-3 text-xs text-amber-600 dark:text-amber-400"
            role="status"
          >
            {t('settings:embedding.requiresEngineNotice', {
              engine: EMBEDDING_ENGINE_UI.name,
              version: readiness.required,
            })}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <DetailCell label={t('hub:embeddingInputs')}>
            <span
              className="flex flex-wrap gap-1"
              data-testid={`embedding-modalities-${model.id}`}
            >
              {model.modalities.map((modality) => (
                <span
                  key={modality}
                  className="rounded-[5px] bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                >
                  {t(`hub:embeddingModality.${modality}`)}
                </span>
              ))}
            </span>
          </DetailCell>
          <DetailCell label={t('hub:embeddingDimensions')}>
            {model.dims}
            {model.matryoshka_dims && (
              <span className="font-normal text-muted-foreground">
                {' · '}
                {t('hub:embeddingMatryoshka', {
                  dims: model.matryoshka_dims.join(', '),
                })}
              </span>
            )}
          </DetailCell>
          <DetailCell label={t('hub:context')}>
            {model.max_context > model.context
              ? t('hub:embeddingContextOfMax', {
                  tokens: model.context,
                  max: model.max_context,
                })
              : t('settings:embedding.context', { tokens: model.context })}
          </DetailCell>
          <DetailCell label={t('hub:embeddingPooling')}>
            <span className="font-mono">{model.pooling}</span>
          </DetailCell>
          <DetailCell label={t('hub:parameters')}>{model.params}</DetailCell>
          <DetailCell label={t('hub:languages')}>{languages}</DetailCell>
          <DetailCell label={t('hub:license')}>{model.license}</DetailCell>
        </dl>
      </section>

      {prompts.length > 0 && (
        <section
          className="rounded-lg border border-border bg-card p-4"
          data-testid={`embedding-prompts-${model.id}`}
        >
          <h2 className="mb-1 text-sm font-medium">
            {t('hub:embeddingPrompts')}
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('hub:embeddingPromptsNote')}
          </p>
          <div className="flex flex-col gap-2">
            {prompts.map(({ kind, text }) => {
              const label =
                kind === 'query'
                  ? t('hub:embeddingPromptQuery')
                  : t('hub:embeddingPromptDocument')
              return (
                <div
                  key={kind}
                  className="flex items-start gap-2 rounded-md bg-muted/40 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <code className="mt-1 block whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                      {text}
                    </code>
                  </div>
                  <CopyButton
                    text={text}
                    ariaLabel={t('hub:embeddingCopyPrompt', { name: label })}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}

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
