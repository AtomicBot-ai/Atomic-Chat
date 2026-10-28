import { memo } from 'react'
import { IconChevronDown, IconMovie, IconPhoto } from '@tabler/icons-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ModelLogo } from '@/containers/ModelLogo'
import { useImageForm } from '@/hooks/useImageForm'
import { useMediaTarget } from '@/hooks/useMediaTarget'
import { useRemoteMediaTarget } from '@/hooks/useRemoteMedia'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn, getProviderTitle } from '@/lib/utils'
import type { DiffusionModality } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelRuntimeAction } from './ImageModelRuntimeAction'
import { ImageModelSelector } from './ImageModelSelector'
import { MediaModelPickerButton } from './MediaStudio'
import { RemoteModelLogo } from './RemoteModelSections'

type ImageModelPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The page the picker serves. It shows and selects only that modality's
   * checkpoints: a resident video model is not the Images page's model, and
   * the other way round.
   */
  modality?: DiffusionModality
}

/**
 * The header's model control: the selected checkpoint and its state in the
 * trigger, the full Installed / Available manager in the popover — the same
 * place the chat page keeps its model picker, so the two pages read alike.
 */
export const ImageModelPicker = memo(function ImageModelPicker({
  open,
  onOpenChange,
  modality = 'image',
}: ImageModelPickerProps) {
  const { t } = useTranslation()
  const status = useImageGenerationStore((state) => state.status)
  const { artifactId: displayArtifactId, artifact: displayArtifact } =
    useMediaTarget(modality)
  const workflow = useImageForm((state) => state.workflow)
  // A picked provider model is the page's model over any local one, resident or not.
  const remoteImage = useRemoteMediaTarget('image')
  const remoteVideo = useRemoteMediaTarget('video')
  const remote = modality === 'video' ? remoteVideo : remoteImage
  const showArtifact =
    !remote && Boolean(displayArtifactId && displayArtifact.complete)

  const loadedName = status?.model.loaded?.displayName ?? null
  const selectLabel =
    modality === 'video' ? t('videos:model.select') : t('images:model.select')
  const name = remote
    ? remote.descriptor.name
    : showArtifact
      ? (displayArtifact.family?.name ?? loadedName ?? selectLabel)
      : selectLabel
  const detail = remote
    ? getProviderTitle(remote.provider.provider)
    : showArtifact
      ? displayArtifact.quant?.label
      : null
  const stateLabel = remote
    ? null
    : displayArtifact.loaded
      ? t('images:model.loaded')
      : displayArtifact.loading
        ? modality === 'video'
          ? t('videos:model.startingToast')
          : t('images:model.startingToast')
        : displayArtifact.unloading
          ? modality === 'video'
            ? t('videos:model.stoppingToast')
            : t('images:model.stoppingToast')
          : showArtifact
            ? t('images:model.readyToLoad')
            : null

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <MediaModelPickerButton
            title={stateLabel ?? undefined}
            aria-label={selectLabel}
            aria-expanded={open}
            data-testid="image-models-toggle"
          >
            {remote ? (
              <RemoteModelLogo
                provider={remote.provider}
                descriptor={remote.descriptor}
                className="size-5 rounded-md"
              />
            ) : showArtifact && displayArtifact.family ? (
              <ModelLogo
                icon={DIFFUSION_FAMILY_ICON_KEYS[displayArtifact.family.id]}
                name={displayArtifact.family.name}
                author={displayArtifact.family.developer}
                className="size-5 rounded-md"
              />
            ) : modality === 'video' ? (
              <IconMovie size={16} className="shrink-0 text-muted-foreground" />
            ) : (
              <IconPhoto size={16} className="shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                'truncate font-medium',
                !showArtifact && !remote && 'text-muted-foreground'
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
          </MediaModelPickerButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          // A heavier shadow than the default: the panel opens over the form,
          // which is the same white, and must read as lifted off it. 400 px
          // holds a card row of the longest quant, a fit badge, a two-digit
          // GB size and the Download slot without cutting the size.
          className="max-h-[min(60vh,480px)] w-[400px] max-w-[calc(100vw-2rem)] origin-[var(--radix-popover-content-transform-origin)] overflow-y-auto rounded-xl border bg-background/95 p-1.5 shadow-xl backdrop-blur-2xl"
        >
          <ImageModelSelector
            variant="page"
            modality={modality}
            onRemotePicked={() => onOpenChange(false)}
            {...(modality === 'image' ? { workflow } : {})}
          />
        </PopoverContent>
      </Popover>
      {showArtifact && displayArtifactId && (
        <ImageModelRuntimeAction
          artifactId={displayArtifactId}
          modelName={name}
          modality={modality}
          appearance="indicator"
        />
      )}
    </div>
  )
})

export default ImageModelPicker
