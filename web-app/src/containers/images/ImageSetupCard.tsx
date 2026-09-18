import { memo } from 'react'
import {
  IconChevronRight,
  IconCircleCheckFilled,
  IconCircleDashed,
} from '@tabler/icons-react'
import { ImageIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  useImageGenerationStore,
  type ImageSetupStep,
} from '@/stores/image-generation-store'

type ImageSetupCardProps = {
  className?: string
}

/**
 * What the page shows until both prerequisites — the engine binary and at
 * least one complete checkpoint — are in place. Each row opens the setup
 * wizard on its own step, so "install the engine" and "get a model" are one
 * click each rather than a tour.
 */
export const ImageSetupCard = memo(function ImageSetupCard({
  className,
}: ImageSetupCardProps) {
  const { t } = useTranslation()
  const { installed: engineInstalled, hostBackendId, hostBackendReason } =
    useImageEngine()
  const hasModel = useImageGenerationStore((state) =>
    state.installedArtifacts.some((artifact) => artifact.complete)
  )
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const unsupported = hostBackendId === null && Boolean(hostBackendReason)

  const rows: Array<{ step: ImageSetupStep; done: boolean; label: string }> = [
    { step: 1, done: engineInstalled, label: t('images:setup.card.engine') },
    { step: 2, done: hasModel, label: t('images:setup.card.model') },
  ]

  return (
    <div
      className={cn('space-y-4 rounded-xl border bg-secondary/40 p-4', className)}
      data-testid="image-setup-card"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-background">
          <ImageIcon size={20} />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t('images:setup.card.title')}</p>
          <p className="text-xs leading-snug text-muted-foreground">
            {unsupported
              ? t('images:setup.engine.unsupported')
              : t('images:setup.card.description')}
          </p>
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.step}>
            <button
              type="button"
              disabled={unsupported}
              onClick={() => openSetup(row.step)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-60',
                row.done && 'text-muted-foreground'
              )}
            >
              {row.done ? (
                <IconCircleCheckFilled
                  size={16}
                  className="shrink-0 text-emerald-600 dark:text-emerald-400"
                />
              ) : (
                <IconCircleDashed
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 flex-1">{row.label}</span>
              {!row.done && (
                <IconChevronRight
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              )}
            </button>
          </li>
        ))}
      </ul>
      <Button
        className="w-full"
        disabled={unsupported}
        onClick={() => openSetup(engineInstalled ? 2 : 0)}
        data-testid="image-setup-open"
      >
        {t('images:setup.card.button')}
      </Button>
    </div>
  )
})

export default ImageSetupCard
