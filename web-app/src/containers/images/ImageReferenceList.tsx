import { memo, useState } from 'react'
import { IconPhoto, IconPhotoPlus, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MAX_EXTRA_REFERENCES } from '@/lib/diffusion/workflows'
import { ImageGalleryPickerDialog } from './ImageGalleryPickerDialog'
import { useSourceImageUrl } from './useSourceImageUrl'

type ImageReferenceListProps = {
  /** Extra references after the primary one. */
  paths: string[]
  /** No primary yet: adding extras makes no sense. */
  canAdd: boolean
  disabled?: boolean
  /** Pick a file from disk. */
  onAdd: () => void
  /** A gallery image was picked. */
  onAddPath: (path: string) => void
  onRemove: (index: number) => void
}

/**
 * The extra references of the Reference workflow: a thumbnail row per
 * picture with a remove button, and "Add another reference" until the cap.
 */
export const ImageReferenceList = memo(function ImageReferenceList({
  paths,
  canAdd,
  disabled,
  onAdd,
  onAddPath,
  onRemove,
}: ImageReferenceListProps) {
  const { t } = useTranslation()
  const [galleryOpen, setGalleryOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2" data-testid="image-reference-list">
      {paths.map((path, index) => (
        <ReferenceRow
          key={`${index}:${path}`}
          path={path}
          index={index}
          disabled={disabled}
          onRemove={() => onRemove(index)}
        />
      ))}
      {paths.length < MAX_EXTRA_REFERENCES && (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 min-w-0 flex-1 rounded-full text-xs"
            disabled={disabled || !canAdd}
            onClick={onAdd}
            data-testid="image-add-reference"
          >
            <IconPhotoPlus size={14} />
            {t('images:form.addReference')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="size-9 shrink-0 rounded-full"
                disabled={disabled || !canAdd}
                aria-label={t('images:form.addReferenceFromGallery')}
                onClick={() => setGalleryOpen(true)}
                data-testid="image-add-reference-gallery"
              >
                <IconPhoto size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('images:form.addReferenceFromGallery')}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <ImageGalleryPickerDialog
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onPick={(item) => onAddPath(item.path)}
      />
    </div>
  )
})

function ReferenceRow({
  path,
  index,
  disabled,
  onRemove,
}: {
  path: string
  index: number
  disabled?: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { url } = useSourceImageUrl(path)
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/30 p-1.5 pr-2">
      <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary">
        {url && <img src={url} alt="" className="size-full object-cover" draggable={false} />}
      </div>
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium">
          {t('images:form.referenceN', { index: index + 2 })}
        </p>
        <p className="truncate text-muted-foreground" title={path}>
          {path.split(/[\\/]/).pop()}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('images:form.removeReference', { index: index + 2 })}
        disabled={disabled}
        onClick={onRemove}
      >
        <IconX size={14} />
      </Button>
    </div>
  )
}

export default ImageReferenceList
