import { memo } from 'react'
import { IconChevronDown, IconLoader2, IconPhoto } from '@tabler/icons-react'

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
import { familySupportsWorkflow } from '@/lib/diffusion/workflows'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
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
  const selectedArtifactId = useImageSetting((state) => state.selectedArtifactId)
  const selected = useImageArtifact(selectedArtifactId ?? '')
  const workflow = useImageForm((state) => state.workflow)
  // The picked checkpoint cannot run this tab's workflow: say so where the
  // model is named, so the disabled Generate is not a mystery.
  const unsupported =
    selected.family !== null &&
    !familySupportsWorkflow(selected.family.id, workflow)

  const loadedName = status?.model.loaded?.displayName ?? null
  const name = selected.family
    ? selected.family.name
    : loadedName ?? t('images:model.select')
  const loading = status?.model.state === 'loading' || selected.loading
  const detail = loading
    ? t('images:model.loading')
    : selected.family && selected.quant
      ? selected.quant.label
      : null
  const stateLabel = loading
    ? null
    : selected.loaded
      ? t('images:model.loaded')
      : selected.complete
        ? t('images:model.readyToLoad')
        : selected.family
          ? t('images:model.notInstalled')
          : null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={stateLabel ?? undefined}
          aria-label={t('images:model.select')}
          aria-expanded={open}
          data-testid="image-models-toggle"
          className="inline-flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border bg-background px-2.5 text-sm transition-colors duration-150 ease-out hover:bg-secondary/50 active:scale-[0.99]"
        >
          {selected.family ? (
            <ModelLogo
              icon={DIFFUSION_FAMILY_ICON_KEYS[selected.family.id]}
              name={selected.family.name}
              author={selected.family.developer}
              className="size-5 rounded-md"
            />
          ) : (
            <IconPhoto size={16} className="shrink-0 text-muted-foreground" />
          )}
          <span
            className={cn(
              'truncate font-medium',
              !selected.family && !loadedName && 'text-muted-foreground'
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
          {loading ? (
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
  )
})

export default ImageModelPicker
