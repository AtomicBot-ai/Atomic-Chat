import { memo } from 'react'
import {
  IconChevronDown,
  IconLoader2,
  IconPhoto,
  IconPlayerStopFilled,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ModelLogo } from '@/containers/ModelLogo'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageForm } from '@/hooks/useImageForm'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { familySupportsWorkflow } from '@/lib/diffusion/workflows'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelSelector } from './ImageModelSelector'
import { Button } from '@/components/ui/button'

type ImageModelPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The header's model control: the selected checkpoint and its state in the
 * trigger, the full Installed / Available manager in the popover — the same
 * place the chat page keeps its model picker, so the two pages read alike.
 */
export const ImageModelPicker = memo(function ImageModelPicker({
  open,
  onOpenChange,
}: ImageModelPickerProps) {
  const { t } = useTranslation()
  const status = useImageGenerationStore((state) => state.status)
  const loadingArtifactId = useImageGenerationStore(
    (state) => state.loadingArtifactId
  )
  const loadedArtifactId = status?.model.loaded?.modelId ?? null
  const runtimeArtifactId = loadedArtifactId ?? loadingArtifactId
  const runtime = useImageArtifact(runtimeArtifactId ?? '')
  const workflow = useImageForm((state) => state.workflow)
  const generating = useImageGenerationStore((state) => state.generating)
  const unloadModel = useImageGenerationStore((state) => state.unloadModel)
  const runtimeLoading =
    Boolean(runtimeArtifactId) &&
    (status?.model.state === 'loading' || runtime.loading)
  const runtimeLoaded =
    Boolean(loadedArtifactId) && status?.model.state === 'loaded'
  const showRuntime = runtimeLoading || runtimeLoaded

  // The header is runtime status, not remembered selection. Until a model is
  // actually starting or running it intentionally says “Select image model”.
  const unsupported =
    showRuntime &&
    runtime.family !== null &&
    !familySupportsWorkflow(runtime.family.id, workflow)

  const loadedName = status?.model.loaded?.displayName ?? null
  const name = showRuntime
    ? (runtime.family?.name ?? loadedName ?? t('images:model.select'))
    : t('images:model.select')
  const detail = runtimeLoading
    ? t('images:model.loading')
    : runtimeLoaded && runtime.quant
      ? runtime.quant.label
      : null
  const stateLabel = runtimeLoaded ? t('images:model.loaded') : null

  const stopSelected = async () => {
    const toastId = toast.loading(t('images:model.stoppingToast'))
    await unloadModel()
    const stillLoaded =
      useImageGenerationStore.getState().status?.model.state === 'loaded'
    if (stillLoaded) {
      toast.error(t('images:model.stopFailed', { name }), { id: toastId })
    } else {
      toast.success(t('images:model.stoppedToast', { name }), { id: toastId })
    }
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={stateLabel ?? undefined}
            aria-label={t('images:model.select')}
            aria-expanded={open}
            data-testid="image-models-toggle"
            className="inline-flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border bg-background px-2.5 text-sm transition-colors duration-150 ease-out hover:bg-secondary/50 active:scale-[0.99]"
          >
            {showRuntime && runtime.family ? (
              <ModelLogo
                icon={DIFFUSION_FAMILY_ICON_KEYS[runtime.family.id]}
                name={runtime.family.name}
                author={runtime.family.developer}
                className="size-5 rounded-md"
              />
            ) : (
              <IconPhoto size={16} className="shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                'truncate font-medium',
                !showRuntime && 'text-muted-foreground'
              )}
            >
              {name}
            </span>
            {detail && (
              <span className="shrink-0 text-muted-foreground">{detail}</span>
            )}
            {unsupported && (
              <span
                className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
                data-testid="image-model-unsupported"
              >
                {t('images:model.notForWorkflow', {
                  workflow: t(`images:workflow.${workflow}.label`),
                })}
              </span>
            )}
            {runtimeLoading ? (
              <IconLoader2
                size={14}
                className="shrink-0 animate-spin text-muted-foreground"
              />
            ) : (
              <IconChevronDown
                size={14}
                className={cn(
                  'shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                  open && 'rotate-180'
                )}
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          // A heavier shadow than the default: the panel opens over the form,
          // which is the same white, and must read as lifted off it.
          className="max-h-[min(60vh,480px)] w-[380px] max-w-[calc(100vw-2rem)] origin-[var(--radix-popover-content-transform-origin)] overflow-y-auto rounded-xl border bg-background/95 p-1.5 shadow-xl backdrop-blur-2xl"
        >
          <ImageModelSelector variant="page" workflow={workflow} />
        </PopoverContent>
      </Popover>
      {runtimeLoaded && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-9 shrink-0 rounded-xl"
          disabled={generating}
          aria-label={t('images:model.unload')}
          title={t('images:model.unload')}
          onClick={() => void stopSelected()}
        >
          <IconPlayerStopFilled size={15} />
        </Button>
      )}
    </div>
  )
})

export default ImageModelPicker
