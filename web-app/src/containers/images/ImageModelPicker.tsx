import { memo } from 'react'
import { IconChevronDown, IconPhoto } from '@tabler/icons-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ModelLogo } from '@/containers/ModelLogo'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseArtifactId } from '@/lib/diffusion/models'
import { familySupportsWorkflow } from '@/lib/diffusion/workflows'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelRuntimeAction } from './ImageModelRuntimeAction'
import { ImageModelSelector } from './ImageModelSelector'

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
  const unloadingArtifactId = useImageGenerationStore(
    (state) => state.unloadingArtifactId
  )
  const selectedArtifactId = useImageSetting(
    (state) => state.selectedArtifactId
  )
  const loadedArtifactId = status?.model.loaded?.modelId ?? null
  const runtimeArtifactId =
    loadedArtifactId ?? loadingArtifactId ?? unloadingArtifactId
  const runtime = useImageArtifact(runtimeArtifactId ?? '')
  const selected = useImageArtifact(selectedArtifactId ?? '')
  const workflow = useImageForm((state) => state.workflow)
  const runtimeFamilyId =
    runtime.family?.id ?? parseArtifactId(runtimeArtifactId ?? '')?.family ?? null
  const runtimeCompatible =
    Boolean(runtimeArtifactId) &&
    (runtimeFamilyId === null || familySupportsWorkflow(runtimeFamilyId, workflow))
  const selectedFamilyId =
    selected.family?.id ??
    parseArtifactId(selectedArtifactId ?? '')?.family ??
    null
  const selectedCompatible =
    Boolean(selectedArtifactId && selected.complete) &&
    (selectedFamilyId === null ||
      familySupportsWorkflow(selectedFamilyId, workflow))
  const displayArtifactId = runtimeCompatible
    ? runtimeArtifactId
    : selectedCompatible
      ? selectedArtifactId
      : null
  const displayArtifact = useImageArtifact(displayArtifactId ?? '')
  const showArtifact = Boolean(displayArtifactId && displayArtifact.complete)

  // Prefer the resident/in-flight artifact, then the user's compatible
  // installed selection. This keeps an intentionally stopped model visible so
  // its adjacent status control can start it again without reopening the list.

  const loadedName = status?.model.loaded?.displayName ?? null
  const name = showArtifact
    ? (displayArtifact.family?.name ?? loadedName ?? t('images:model.select'))
    : t('images:model.select')
  const detail = showArtifact ? displayArtifact.quant?.label : null
  const stateLabel = displayArtifact.loaded
    ? t('images:model.loaded')
    : displayArtifact.loading
      ? t('images:model.startingToast')
      : displayArtifact.unloading
        ? t('images:model.stoppingToast')
        : showArtifact
          ? t('images:model.readyToLoad')
          : null

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5">
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
            {showArtifact && displayArtifact.family ? (
              <ModelLogo
                icon={DIFFUSION_FAMILY_ICON_KEYS[displayArtifact.family.id]}
                name={displayArtifact.family.name}
                author={displayArtifact.family.developer}
                className="size-5 rounded-md"
              />
            ) : (
              <IconPhoto size={16} className="shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                'truncate font-medium',
                !showArtifact && 'text-muted-foreground'
              )}
            >
              {name}
            </span>
            {detail && (
              <span className="shrink-0 text-muted-foreground">{detail}</span>
            )}
            <IconChevronDown
              size={14}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                open && 'rotate-180'
              )}
            />
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
      {showArtifact && displayArtifactId && (
        <ImageModelRuntimeAction
          artifactId={displayArtifactId}
          modelName={name}
          appearance="indicator"
        />
      )}
    </div>
  )
})

export default ImageModelPicker
