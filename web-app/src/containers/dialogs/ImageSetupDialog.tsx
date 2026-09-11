import { memo, useCallback } from 'react'
import {
  IconCircleCheckFilled,
  IconCpu,
  IconDownload,
  IconLoader2,
  IconLock,
  IconPhoto,
  IconSparkles,
  IconX,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ImageModelSelector } from '@/containers/images/ImageModelSelector'
import { VoiceSetupRow, VoiceSetupRowIcon } from '@/containers/VoiceSetupRow'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/downloadFormat'
import { cn } from '@/lib/utils'
import {
  useImageGenerationStore,
  type ImageSetupStep,
} from '@/stores/image-generation-store'

const TOTAL_STEPS = 3

function StepDots({ step }: { step: number }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-center">
      <div className="flex items-center gap-2" aria-hidden>
        {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
          <span
            key={index}
            className={cn(
              'size-2 rounded-full transition-colors duration-200',
              index === step ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
          />
        ))}
      </div>
      <span className="sr-only">
        {t('images:setup.step', { current: step + 1, total: TOTAL_STEPS })}
      </span>
    </div>
  )
}

const INTRO_BULLETS = [
  { icon: IconLock, text: 'images:setup.intro.bulletLocal' },
  { icon: IconPhoto, text: 'images:setup.intro.bulletRecipes' },
  { icon: IconSparkles, text: 'images:setup.intro.bulletApi' },
] as const

function IntroStep() {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 rounded-xl border bg-secondary/40 p-3">
      {INTRO_BULLETS.map(({ icon: Icon, text }) => (
        <div key={text} className="flex items-center gap-3">
          <VoiceSetupRowIcon size="sm">
            <Icon size={16} />
          </VoiceSetupRowIcon>
          <span className="text-sm leading-snug text-muted-foreground">
            {t(text)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Engine row: install state on the right, progress while the archive comes
 * down, and the reason when this host has no supported build.
 */
export const ImageEngineBlock = memo(function ImageEngineBlock() {
  const { t } = useTranslation()
  const engine = useImageEngine()
  const percent =
    engine.progress.total > 0
      ? Math.round((engine.progress.transferred / engine.progress.total) * 100)
      : 0
  const unsupported = engine.hostBackendId === null

  const action = engine.installing ? (
    <div className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
        <IconLoader2 size={14} className="animate-spin" />
        {percent}%
      </span>
      {engine.progress.total > 0 && (
        <p className="text-right text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {t('images:setup.engine.progress', {
            current: formatBytes(engine.progress.transferred, engine.progress.total),
            total: formatBytes(engine.progress.total, engine.progress.total),
          })}
        </p>
      )}
    </div>
  ) : engine.installed ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
      <IconCircleCheckFilled size={16} />
      {t('images:setup.engine.installed')}
    </span>
  ) : unsupported ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <IconX size={16} />
      {t('images:setup.engine.unsupportedShort')}
    </span>
  ) : (
    <Button size="sm" onClick={() => void engine.startInstall()} data-testid="image-engine-install">
      <IconDownload size={16} />
      {t('images:setup.engine.install')}
    </Button>
  )

  const description =
    engine.install.state === 'installed'
      ? t('images:setup.engine.backend', {
          backend: engine.install.backendId,
          tag: engine.install.tag,
        })
      : engine.hostBackendId
        ? t('images:setup.engine.rowDescription', {
            backend: engine.hostBackendId,
          })
        : undefined

  return (
    <VoiceSetupRow
      media={
        <VoiceSetupRowIcon>
          <IconCpu size={20} />
        </VoiceSetupRowIcon>
      }
      title={t('images:setup.engine.rowTitle')}
      description={description}
      action={action}
      footer={
        engine.progress.error ? (
          <p className="text-xs text-destructive">
            {t('images:setup.engine.failed')}
            {engine.progress.error.message ? ` ${engine.progress.error.message}` : ''}
          </p>
        ) : unsupported ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {engine.hostBackendReason ?? t('images:setup.engine.unsupported')}
          </p>
        ) : undefined
      }
    />
  )
})

const STEPS = [
  {
    icon: IconSparkles,
    title: 'images:setup.intro.title',
    description: 'images:setup.intro.description',
  },
  {
    icon: IconCpu,
    title: 'images:setup.engine.title',
    description: 'images:setup.engine.description',
  },
  {
    icon: IconDownload,
    title: 'images:setup.model.title',
    description: 'images:setup.model.description',
  },
] as const

/**
 * Three-step first-run flow: what it does, install the engine, get a model.
 *
 * Mounted once at the root like `VoiceSetupDialog`, because the setup card,
 * the error banner and the Media settings page all reopen it on a given step.
 */
const ImageSetupDialog = memo(function ImageSetupDialog() {
  const { t } = useTranslation()
  const open = useImageGenerationStore((state) => state.setupOpen)
  const step = useImageGenerationStore((state) => state.setupStep)
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const closeSetup = useImageGenerationStore((state) => state.closeSetup)
  const hasModel = useImageGenerationStore((state) =>
    state.installedArtifacts.some((artifact) => artifact.complete)
  )
  const setSetupCompleted = useImageSetting((state) => state.setSetupCompleted)
  const { installed: engineInstalled } = useImageEngine()

  const go = useCallback(
    (next: number) =>
      openSetup(Math.min(2, Math.max(0, next)) as ImageSetupStep),
    [openSetup]
  )

  const ready = engineInstalled && hasModel

  const finish = useCallback(() => {
    setSetupCompleted(true)
    closeSetup()
  }, [closeSetup, setSetupCompleted])

  const StepIcon = STEPS[step].icon

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openSetup(step) : finish())}>
      <DialogContent className="sm:max-w-lg lg:max-w-lg xl:max-w-lg">
        <DialogHeader
          data-testid="image-setup-header"
          className="items-center text-center sm:text-center"
        >
          <div className="mb-1 grid size-12 place-items-center rounded-xl bg-secondary">
            <StepIcon size={24} className="text-foreground" />
          </div>
          <DialogTitle>{t(STEPS[step].title)}</DialogTitle>
          <DialogDescription
            data-testid="image-setup-description"
            className="h-10 text-pretty"
          >
            {t(STEPS[step].description)}
          </DialogDescription>
        </DialogHeader>

        {/* The model step is a list that can grow with the catalog, so it gets
            a taller box with its own scroll; the other two are fixed. */}
        <div
          data-testid="image-setup-slot"
          className={cn(
            'flex flex-col justify-start gap-2 overflow-y-auto py-1',
            step === 2 ? 'h-[360px]' : 'h-[156px]'
          )}
        >
          {step === 0 && <IntroStep />}
          {step === 1 && (
            <>
              <ImageEngineBlock />
              <p className="text-center text-xs text-muted-foreground">
                {t('images:setup.engine.note')}
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <ImageModelSelector variant="dialog" />
              {!hasModel && (
                <p className="text-center text-xs text-muted-foreground">
                  {t('images:setup.model.diskNote')}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter className="grid grid-cols-3 items-center sm:flex-row sm:justify-between">
          <div className="flex justify-start">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => go(step - 1)}>
                {t('images:setup.back')}
              </Button>
            )}
          </div>
          <StepDots step={step} />
          <div className="flex justify-end">
            {step === 2 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="sm"
                      disabled={!ready}
                      data-testid="image-setup-done"
                      onClick={finish}
                    >
                      {t('images:setup.done')}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!ready && (
                  <TooltipContent align="end">
                    <p>{t('images:setup.doneBlocked')}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            ) : (
              <Button size="sm" onClick={() => go(step + 1)}>
                {t('images:setup.next')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default ImageSetupDialog
