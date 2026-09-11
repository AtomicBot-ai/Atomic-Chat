import { memo } from 'react'
import { IconCircleCheckFilled, IconCircleDashed, IconSparkles } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  useImageGenerationStore,
  type ImageSetupStep,
} from '@/stores/image-generation-store'

/**
 * What the form column shows until both prerequisites — the engine binary and
 * at least one complete checkpoint — are in place. Each row opens the setup
 * wizard on its own step, so "install the engine" and "get a model" are one
 * click each rather than a tour.
 */
export const ImageSetupCard = memo(function ImageSetupCard() {
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
      className="space-y-4 rounded-xl border bg-secondary/40 p-4"
      data-testid="image-setup-card"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-background">
          <IconSparkles size={20} />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('images:setup.card.title')}</p>
          <p className="text-xs text-muted-foreground">
            {unsupported
              ? t('images:setup.engine.unsupported')
              : t('images:setup.card.description')}
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.step}>
            <button
              type="button"
              disabled={unsupported}
              onClick={() => openSetup(row.step)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary disabled:opacity-60',
                row.done && 'text-muted-foreground'
              )}
            >
              {row.done ? (
                <IconCircleCheckFilled
                  size={16}
                  className="text-emerald-600 dark:text-emerald-400"
                />
              ) : (
                <IconCircleDashed size={16} className="text-muted-foreground" />
              )}
              {row.label}
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
