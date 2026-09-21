import {
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconPlayerPlay,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'

type RuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping'

type ImageModelRuntimeActionProps = {
  artifactId: string
  modelName: string
  appearance?: 'row' | 'indicator'
  disabled?: boolean
  className?: string
}

/**
 * One stable start/stop slot for an installed image artifact. The list uses a
 * fixed-width text action; the selected-model pill uses the same state machine
 * in a compact status control. Async phases replace content inside the slot so
 * neither parent can grow while the native renderer starts or stops.
 */
export function ImageModelRuntimeAction({
  artifactId,
  modelName,
  appearance = 'row',
  disabled = false,
  className,
}: ImageModelRuntimeActionProps) {
  const { t } = useTranslation()
  const artifact = useImageArtifact(artifactId)
  const unloadModel = useImageGenerationStore((state) => state.unloadModel)
  const generating = useImageGenerationStore((state) => state.generating)
  const loadingArtifactId = useImageGenerationStore(
    (state) => state.loadingArtifactId
  )
  const unloadingArtifactId = useImageGenerationStore(
    (state) => state.unloadingArtifactId
  )
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )

  const phase: RuntimePhase = artifact.unloading
    ? 'stopping'
    : artifact.loading
      ? 'starting'
      : artifact.loaded
        ? 'ready'
        : 'idle'
  const anotherTransitionActive = Boolean(
    (loadingArtifactId && loadingArtifactId !== artifactId) ||
      (unloadingArtifactId && unloadingArtifactId !== artifactId)
  )
  const busy = phase === 'starting' || phase === 'stopping'
  const actionDisabled =
    disabled || generating || busy || anotherTransitionActive || !artifact.complete
  const label =
    phase === 'ready'
      ? t('images:model.unload')
      : phase === 'starting'
        ? t('images:model.startingToast')
        : phase === 'stopping'
          ? t('images:model.stoppingToast')
          : t('images:model.load')

  const start = async () => {
    if (actionDisabled || phase !== 'idle') return
    setSelectedArtifactId(artifactId)
    const toastId = `image-model-runtime-${artifactId}`
    toast.loading(t('images:model.startingToast'), { id: toastId })
    await artifact.load()
    const loadedId =
      useImageGenerationStore.getState().status?.model.loaded?.modelId
    if (loadedId === artifactId) {
      toast.success(t('images:model.startedToast', { name: modelName }), {
        id: toastId,
      })
    } else {
      toast.error(t('images:model.startFailed', { name: modelName }), {
        id: toastId,
      })
    }
  }

  const stop = async () => {
    if (actionDisabled || phase !== 'ready') return
    const toastId = `image-model-runtime-${artifactId}`
    toast.loading(t('images:model.stoppingToast'), { id: toastId })
    await unloadModel()
    const stillLoaded =
      useImageGenerationStore.getState().status?.model.loaded?.modelId ===
      artifactId
    if (stillLoaded) {
      toast.error(t('images:model.stopFailed', { name: modelName }), {
        id: toastId,
      })
    } else {
      toast.success(t('images:model.stoppedToast', { name: modelName }), {
        id: toastId,
      })
    }
  }

  const activate = () => void (phase === 'ready' ? stop() : start())

  if (appearance === 'indicator') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-testid="image-model-runtime-indicator"
              data-phase={phase}
              disabled={actionDisabled}
              onClick={activate}
              className={cn(
                'group/image-runtime flex size-7 shrink-0 items-center justify-center rounded-full border bg-secondary/40 outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                className
              )}
            >
              {busy ? (
                <IconLoader2
                  size={14}
                  aria-hidden
                  className="animate-spin text-muted-foreground"
                />
              ) : phase === 'ready' ? (
                <>
                  <IconCircleCheck
                    size={15}
                    stroke={1.8}
                    aria-hidden
                    className="text-emerald-600 group-hover/image-runtime:hidden group-focus-visible/image-runtime:hidden dark:text-emerald-400"
                  />
                  <IconCircleX
                    size={15}
                    stroke={1.8}
                    aria-hidden
                    className="hidden text-destructive group-hover/image-runtime:block group-focus-visible/image-runtime:block"
                  />
                </>
              ) : (
                <IconPlayerPlay
                  size={14}
                  stroke={1.8}
                  aria-hidden
                  className="text-muted-foreground"
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-44 px-2.5 text-left text-pretty">
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Button
      size="sm"
      variant={phase === 'ready' ? 'outline' : 'default'}
      className={cn('h-7 w-16 shrink-0 justify-center px-0', className)}
      aria-label={label}
      title={label}
      data-testid="image-model-runtime-action"
      data-phase={phase}
      disabled={actionDisabled}
      onClick={activate}
    >
      {busy ? (
        <IconLoader2 size={14} aria-hidden className="animate-spin" />
      ) : phase === 'ready' ? (
        t('images:model.unload')
      ) : (
        t('images:model.load')
      )}
    </Button>
  )
}

export default ImageModelRuntimeAction
