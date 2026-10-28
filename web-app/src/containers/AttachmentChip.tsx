import { IconX } from '@tabler/icons-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, formatBytes } from '@/lib/utils'

const ATTACHMENT_ICON_BASE = '/icons/file-attachments'

const resolveExt = (
  name: string,
  fileType?: string,
  mimeType?: string
): string =>
  (
    fileType ||
    mimeType?.split('/')[1] ||
    name.split('.').pop() ||
    ''
  ).toLowerCase()

const pickAttachmentIconSrc = (params: {
  name: string
  fileType?: string
  mimeType?: string
}): string => {
  const ext = resolveExt(params.name, params.fileType, params.mimeType)
  switch (ext) {
    case 'pdf':
      return `${ATTACHMENT_ICON_BASE}/pdf.svg`
    case 'docx':
      return `${ATTACHMENT_ICON_BASE}/docx.svg`
    case 'doc':
      return `${ATTACHMENT_ICON_BASE}/doc.svg`
    case 'txt':
    case 'md':
    case 'markdown':
      return `${ATTACHMENT_ICON_BASE}/txt.svg`
    case 'csv':
      return `${ATTACHMENT_ICON_BASE}/csv.svg`
    case 'xls':
    case 'xlsx':
      return `${ATTACHMENT_ICON_BASE}/xls.svg`
    case 'mp3':
    case 'mpeg':
    case 'wav':
      return `${ATTACHMENT_ICON_BASE}/audio.svg`
    case 'mp4':
    case 'm4v':
    case 'mov':
    case 'quicktime':
    case 'webm':
      return `${ATTACHMENT_ICON_BASE}/video.svg`
    default:
      return `${ATTACHMENT_ICON_BASE}/default.svg`
  }
}

export type AttachmentChipProps = {
  name: string
  fileType?: string
  mimeType?: string
  size?: number
  error?: string
  isProcessing?: boolean
  /** A line under the file's meta in the tooltip. */
  note?: string
  /** Opens the attachment's preview; the chip is clickable only with it. */
  onOpen?: () => void
  onRemove?: () => void
  onRetry?: () => void
  className?: string
}

export const AttachmentChip = ({
  name,
  fileType,
  mimeType,
  size,
  error,
  isProcessing = false,
  note,
  onOpen,
  onRemove,
  onRetry,
  className,
}: AttachmentChipProps) => {
  const hasError = Boolean(error) && !isProcessing
  const ext = resolveExt(name, fileType, mimeType).toUpperCase()
  const meta = [ext || 'FILE', formatBytes(size)].filter(Boolean).join(' · ')
  const fileIconSrc = pickAttachmentIconSrc({ name, fileType, mimeType })
  const showRemove = !isProcessing && Boolean(onRemove)
  const showRetry = hasError && Boolean(onRetry)
  const canOpen = !isProcessing && !hasError && Boolean(onOpen)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role={canOpen ? 'button' : undefined}
          tabIndex={canOpen ? 0 : undefined}
          aria-label={canOpen ? name : undefined}
          onClick={canOpen ? () => onOpen?.() : undefined}
          onKeyDown={
            canOpen
              ? (e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen?.()
                  }
                }
              : undefined
          }
          className={cn(
            'group/chip relative flex items-center gap-3 pl-2 py-1.5 rounded-2xl w-[220px] transition-colors',
            showRemove ? 'pr-7' : 'pr-3',
            !hasError && 'bg-muted/50 hover:bg-muted',
            hasError && 'bg-destructive/10 hover:bg-destructive/15',
            canOpen &&
              'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          <div className="relative shrink-0 size-9 flex items-center justify-center">
            {isProcessing ? (
              <img
                src={`${ATTACHMENT_ICON_BASE}/spinner.svg`}
                alt=""
                aria-hidden="true"
                className="size-7 animate-spin"
              />
            ) : hasError ? (
              <>
                <img
                  src={`${ATTACHMENT_ICON_BASE}/alert.svg`}
                  alt=""
                  aria-hidden="true"
                  className={cn(
                    'size-7',
                    showRetry && 'group-hover/chip:hidden'
                  )}
                />
                {showRetry && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRetry?.()
                    }}
                    className="hidden group-hover/chip:flex items-center justify-center size-9 rounded-xl bg-background/60 hover:bg-background cursor-pointer"
                    aria-label="Retry"
                  >
                    <img
                      src={`${ATTACHMENT_ICON_BASE}/retry.svg`}
                      alt=""
                      aria-hidden="true"
                      className="size-5"
                    />
                  </button>
                )}
              </>
            ) : (
              <img
                src={fileIconSrc}
                alt=""
                aria-hidden="true"
                className="h-9 w-auto max-w-9 object-contain"
              />
            )}
          </div>

          <div className="flex flex-col min-w-0 flex-1">
            <span
              className="text-sm font-medium truncate leading-tight"
              title={name}
            >
              {name}
            </span>
            <span className="text-xs text-muted-foreground truncate leading-tight">
              {meta}
            </span>
          </div>

          {showRemove && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRemove?.()
              }}
              className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Remove"
            >
              <IconX size={13} />
            </button>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div className="font-medium truncate max-w-52" title={name}>
            {name}
          </div>
          <div className="opacity-70">{meta || 'document'}</div>
          {note && <div className="opacity-70 mt-1 max-w-52">{note}</div>}
          {hasError && (
            <div className="text-destructive mt-1 max-w-52 break-words">
              {error}
            </div>
          )}
          {isProcessing && (
            <div className="opacity-70 mt-1">Preparing attachment...</div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
