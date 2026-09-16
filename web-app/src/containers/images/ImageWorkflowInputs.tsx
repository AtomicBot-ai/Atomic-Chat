import { memo, useCallback, useState } from 'react'
import { useShallow } from 'zustand/shallow'

import { Button } from '@/components/ui/button'
import { useTauriDragDrop } from '@/containers/chatInput/useTauriDragDrop'
import { useImageForm, type ImageSourceFile } from '@/hooks/useImageForm'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { anySide } from '@/lib/diffusion/outpaint'
import { scaleWithin, type DimConstraints } from '@/lib/diffusion/size'
import {
  SOURCE_IMAGE_EXTENSIONS,
  isSourceImagePath,
  workflowSpec,
} from '@/lib/diffusion/workflows'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { ImageField } from './ImageField'
import { ImageMaskCanvas } from './ImageMaskCanvas'
import { ImageParamSlider } from './ImageParamSlider'
import { ImageReferenceList } from './ImageReferenceList'
import { ImageSidesToggle } from './ImageSidesToggle'
import { ImageSourceDropzone } from './ImageSourceDropzone'
import { useSourceImageUrl } from './useSourceImageUrl'

type ImageWorkflowInputsProps = {
  workflow: ImageWorkflowId
  constraints: DimConstraints
  /** What the job will produce, from `useImageGeneration`. */
  outputSize: { width: number; height: number }
  disabled?: boolean
}

/** Where a dropped file lands: the source, or a new extra reference. */
type DropTarget = 'source' | 'reference'

/**
 * The inputs above the prompt that only an image-to-image workflow has:
 * the source picture, and the knobs of the workflow at hand. `create` has
 * none and renders nothing.
 *
 * Drops are window-wide in Tauri, so this component (mounted once per form)
 * owns the listener and routes the file to whichever slot is waiting:
 * the source by default, or a reference slot after "Add another reference".
 */
export const ImageWorkflowInputs = memo(function ImageWorkflowInputs({
  workflow,
  constraints,
  outputSize,
  disabled,
}: ImageWorkflowInputsProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const form = useImageForm(
    useShallow((state) => ({
      sourceImage: state.sourceImage,
      maskBase64: state.maskBase64,
      maskResetKey: state.maskResetKey,
      referenceImages: state.referenceImages,
      strength: state.strength,
      brushSize: state.brushSize,
      expandPercent: state.expandPercent,
      sides: state.sides,
      upscaleFactor: state.upscaleFactor,
      upscaleStrength: state.upscaleStrength,
      patch: state.patch,
      setSourceImage: state.setSourceImage,
      clearMask: state.clearMask,
      addReference: state.addReference,
      removeReference: state.removeReference,
    }))
  )
  const spec = workflowSpec(workflow)
  const [dragOver, setDragOver] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget>('source')
  const [pendingReference, setPendingReference] = useState(false)

  const onDrop = useCallback(
    (paths: string[]) => {
      const path = paths.find(isSourceImagePath)
      if (!path || disabled) return
      if (dropTarget === 'reference' && form.sourceImage) {
        form.addReference(path)
        setPendingReference(false)
        setDropTarget('source')
      } else {
        form.setSourceImage({ path, width: 0, height: 0 })
      }
    },
    [disabled, dropTarget, form]
  )

  useTauriDragDrop({
    enabled: spec.needsSource,
    onDragOver: () => setDragOver(true),
    onDragLeave: () => setDragOver(false),
    onDrop,
  })

  if (!spec.needsSource) return null

  const source = form.sourceImage

  const pickReference = async () => {
    try {
      const selected = await serviceHub.dialog().open({
        multiple: false,
        filters: [
          { name: t('images:form.imageFiles'), extensions: [...SOURCE_IMAGE_EXTENSIONS] },
        ],
      })
      const chosen = Array.isArray(selected) ? selected[0] : selected
      if (chosen) form.addReference(chosen)
    } finally {
      setPendingReference(false)
      setDropTarget('source')
    }
  }
  const onPick = (picked: ImageSourceFile | null) => {
    if (picked && source && picked.path === source.path) {
      // The picture decoded: keep the path, take the size.
      form.patch({ sourceImage: picked })
    } else {
      form.setSourceImage(picked)
    }
  }
  const sizeCaption =
    source && source.width > 0
      ? t('images:form.sourceSize', { width: source.width, height: source.height })
      : undefined
  const outputCaption = t('images:form.outputSize', outputSize)

  const dropzone = (label: string) => (
    <ImageField label={label}>
      <ImageSourceDropzone
        path={source?.path ?? null}
        onPick={onPick}
        dragOver={dragOver && dropTarget === 'source'}
        disabled={disabled}
        caption={sizeCaption}
      />
    </ImageField>
  )

  const strengthSlider = (
    <ImageParamSlider
      id="image-strength"
      label={t('images:form.strength')}
      description={t('images:form.strengthHint')}
      value={form.strength}
      min={0.1}
      max={1}
      step={0.05}
      disabled={disabled}
      onChange={(strength) => form.patch({ strength })}
    />
  )

  switch (workflow) {
    case 'transform':
      return (
        <>
          {dropzone(t('images:form.sourceImage'))}
          {strengthSlider}
        </>
      )

    case 'inpaint':
      return (
        <>
          {source && source.width > 0 ? (
            <InpaintMask
              source={source}
              brushSize={form.brushSize}
              resetKey={form.maskResetKey}
              disabled={disabled}
              onMaskChange={(maskBase64) => form.patch({ maskBase64 })}
              onBrushChange={(brushSize) => form.patch({ brushSize })}
              onClear={form.clearMask}
              onReplace={() => form.setSourceImage(null)}
            />
          ) : (
            dropzone(t('images:form.sourceImage'))
          )}
          {strengthSlider}
        </>
      )

    case 'extend':
      return (
        <>
          {dropzone(t('images:form.sourceImage'))}
          <ImageParamSlider
            id="image-expand"
            label={t('images:form.expandBy')}
            description={t('images:form.expandHint')}
            value={form.expandPercent}
            min={10}
            max={100}
            step={5}
            disabled={disabled}
            onChange={(expandPercent) => form.patch({ expandPercent })}
          />
          <ImageField
            label={t('images:form.sides')}
            trailing={
              source && anySide(form.sides) ? (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {outputCaption}
                </span>
              ) : undefined
            }
          >
            <ImageSidesToggle
              value={form.sides}
              disabled={disabled}
              onChange={(sides) => form.patch({ sides })}
            />
          </ImageField>
        </>
      )

    case 'upscale': {
      const effective = source
        ? scaleWithin(source.width, source.height, form.upscaleFactor, constraints).factor
        : form.upscaleFactor
      return (
        <>
          {dropzone(t('images:form.sourceImage'))}
          <ImageParamSlider
            id="image-upscale-factor"
            label={t('images:form.scale')}
            description={t('images:form.scaleHint')}
            value={form.upscaleFactor}
            min={1.5}
            max={4}
            step={0.5}
            disabled={disabled}
            onChange={(upscaleFactor) => form.patch({ upscaleFactor })}
          />
          {source && source.width > 0 && (
            <p
              className="-mt-2 text-[11px] tabular-nums text-muted-foreground"
              data-testid="image-upscale-output"
            >
              {outputCaption}
              {effective < form.upscaleFactor && ` · ×${effective.toFixed(2)}`}
            </p>
          )}
          <ImageParamSlider
            id="image-upscale-strength"
            label={t('images:form.detailStrength')}
            description={t('images:form.detailStrengthHint')}
            value={form.upscaleStrength}
            min={0.1}
            max={0.6}
            step={0.05}
            disabled={disabled}
            onChange={(upscaleStrength) => form.patch({ upscaleStrength })}
          />
        </>
      )
    }

    case 'reference':
      return (
        <>
          {dropzone(t('images:form.referenceImage'))}
          <ImageReferenceList
            paths={form.referenceImages}
            canAdd={source !== null}
            disabled={disabled}
            onAdd={() => {
              // The next pick or drop fills a reference slot.
              setPendingReference(true)
              setDropTarget('reference')
              void pickReference()
            }}
            onAddPath={form.addReference}
            onRemove={form.removeReference}
          />
          {pendingReference && (
            <p className="-mt-1 text-[11px] text-muted-foreground">
              {t('images:form.dropzone')}
            </p>
          )}
        </>
      )

    case 'edit':
      return dropzone(t('images:form.sourceImage'))

    default:
      return null
  }

})

type InpaintMaskProps = {
  source: ImageSourceFile
  brushSize: number
  resetKey: number
  disabled?: boolean
  onMaskChange: (maskBase64: string | null) => void
  onBrushChange: (brushSize: number) => void
  onClear: () => void
  onReplace: () => void
}

/** The mask editor over the source, with the brush and the two buttons. */
function InpaintMask({
  source,
  brushSize,
  resetKey,
  disabled,
  onMaskChange,
  onBrushChange,
  onClear,
  onReplace,
}: InpaintMaskProps) {
  const { t } = useTranslation()
  const { url } = useSourceImageUrl(source.path)
  return (
    <>
      <ImageField label={t('images:form.mask')} hint={t('images:form.maskHint')}>
        {url ? (
          <ImageMaskCanvas
            src={url}
            width={source.width}
            height={source.height}
            brushPercent={brushSize}
            resetKey={resetKey}
            disabled={disabled}
            onMaskChange={onMaskChange}
          />
        ) : (
          <div className="h-40 animate-pulse rounded-2xl bg-secondary/40" />
        )}
      </ImageField>
      <ImageParamSlider
        id="image-brush"
        label={t('images:form.brushSize')}
        value={brushSize}
        min={2}
        max={25}
        step={1}
        disabled={disabled}
        onChange={onBrushChange}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClear}>
          {t('images:form.clearMask')}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onReplace}>
          {t('images:form.replaceImage')}
        </Button>
      </div>
    </>
  )
}

export default ImageWorkflowInputs
