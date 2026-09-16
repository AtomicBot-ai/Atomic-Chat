/**
 * "Add file" for an image parameter: pick a picture, see it, remove it.
 *
 * Used beside the prompt for a model's first image parameter (a starting image,
 * or a video's first frame) and in the settings grid for any other one (a
 * video's last frame). The chosen picture is kept as a data URL - see
 * `imageFile.ts`.
 */

import { useRef, useState } from 'react'
import { IconPaperclip, IconX } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { isImageDataUrl, readImageFileAsDataUrl } from './imageFile'

export type ImageFileInputProps = {
  /** DOM id of the file input. */
  id: string
  /** What the picture is for, e.g. "Starting image". */
  label: string
  value: unknown
  disabled?: boolean
  onChange: (value: string | undefined) => void
  /** The small paperclip button used beside the prompt. */
  compact?: boolean
  /** MIME types the parameter accepts. */
  accept?: string[]
}

export function ImageFileInput({
  id,
  label,
  value,
  disabled,
  onChange,
  compact = false,
  accept,
}: ImageFileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attached = isImageDataUrl(value)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const dataUrl = await readImageFileAsDataUrl(file)
      setFileName(file.name)
      onChange(dataUrl)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      // Picking the same file again after removing it must still fire.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = () => {
    setFileName(null)
    setError(null)
    onChange(undefined)
  }

  return (
    <div className={cn('flex flex-col gap-1', compact && 'min-w-0')}>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={(accept?.length ? accept : ['image/png', 'image/jpeg', 'image/webp']).join(',')}
        aria-label={`Add ${label}`}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      {attached ? (
        <div className="flex min-w-0 items-center gap-2">
          <img
            src={value}
            alt={label}
            className={cn(
              'shrink-0 rounded-md border border-border/60 object-cover',
              compact ? 'size-9' : 'size-16'
            )}
          />
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={fileName ?? label}>
            {fileName ?? label}
          </span>
          <button
            type="button"
            onClick={remove}
            disabled={disabled}
            aria-label={`Remove ${label}`}
            className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <IconX size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          title={`Add ${label}`}
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
            compact
              ? 'rounded-full border border-border/70 px-3 py-1.5'
              : 'h-9 w-full justify-center rounded-lg border border-dashed border-border/70'
          )}
        >
          <IconPaperclip size={14} />
          {compact ? 'Add file' : `Choose ${label.toLowerCase()}`}
        </button>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
