import { memo } from 'react'
import { IconCircleCheckFilled, IconSparkles } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { ImageIcon } from '@/components/animated-icon/image'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'

type ImageSetupCardProps = {
  className?: string
}

/**
 * What the page shows until the engine binary is installed — the one thing
 * the studio cannot open without. The rows are the road ahead: the engine row
 * opens the wizard on its install step; the model row is only a preview,
 * because models are fetched from the form's picker once the studio is open.
 */
export const ImageSetupCard = memo(function ImageSetupCard({
  className,
}: ImageSetupCardProps) {
  const { t } = useTranslation()
  const { hostBackendId, hostBackendReason } = useImageEngine()
  const hasModel = useImageGenerationStore((state) =>
    state.installedArtifacts.some((artifact) => artifact.complete)
  )
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const unsupported = hostBackendId === null && Boolean(hostBackendReason)

  const rows: Array<{
    id: 'engine' | 'model'
    done: boolean
    label: string
    description: string
  }> = [
    {
      id: 'engine',
      done: false,
      label: t('images:setup.card.engine'),
      description: t('images:setup.card.engineDescription'),
    },
    {
      id: 'model',
      done: hasModel,
      label: t('images:setup.card.model'),
      description: t('images:setup.card.modelDescription'),
    },
  ]

  return (
    <div
      className={cn('w-full max-w-2xl space-y-7 px-6 py-8', className)}
      data-testid="image-setup-card"
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 grid size-16 place-items-center rounded-2xl border bg-secondary/60 shadow-sm">
          <ImageIcon size={32} aria-hidden />
        </div>
        <h1 className="font-studio text-3xl font-semibold tracking-tight">
          {t('images:setup.card.title')}
        </h1>
        <p className="mt-2 max-w-lg text-pretty text-sm leading-relaxed text-muted-foreground">
          {unsupported
            ? t('images:setup.engine.unsupported')
            : t('images:setup.card.description')}
        </p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        {rows.map((row, index) => {
          const content = (
            <>
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold',
                  row.done
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-secondary text-foreground'
                )}
              >
                {row.done ? <IconCircleCheckFilled size={17} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{row.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {row.description}
                </span>
              </span>
            </>
          )
          const frame =
            'flex h-full w-full items-start gap-3 rounded-xl border bg-background p-4 text-left'
          return (
            <li key={row.id} data-testid={`image-setup-row-${row.id}`}>
              {row.id === 'engine' ? (
                <button
                  type="button"
                  onClick={() => openSetup(1)}
                  className={cn(
                    frame,
                    'transition-colors hover:border-foreground/20 hover:bg-secondary/40'
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className={frame}>{content}</div>
              )}
            </li>
          )
        })}
      </ol>
      <Button
        size="lg"
        className="mx-auto flex min-w-48"
        onClick={() => openSetup(0)}
        data-testid="image-setup-open"
      >
        <IconSparkles size={17} />
        {t('images:setup.card.button')}
      </Button>
    </div>
  )
})

export default ImageSetupCard
