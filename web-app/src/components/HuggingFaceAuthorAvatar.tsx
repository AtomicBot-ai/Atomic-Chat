import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

type HuggingFaceAuthorAvatarProps = {
  author: string
  className?: string
  initials: string
}

//* Аватар автора модели с Hugging Face: сначала organization, затем user, иначе инициалы
export function HuggingFaceAuthorAvatar({
  author,
  className,
  initials,
}: HuggingFaceAuthorAvatarProps) {
  const [phase, setPhase] = useState<0 | 1 | 2>(0)

  useEffect(() => {
    setPhase(0)
  }, [author])

  const handleError = useCallback(() => {
    setPhase((p) => {
      if (p === 0) return 1
      return 2
    })
  }, [])

  const trimmed = author.trim()
  const enc = encodeURIComponent(trimmed)
  const src =
    phase === 0
      ? `https://huggingface.co/api/organizations/${enc}/avatar`
      : phase === 1
        ? `https://huggingface.co/api/users/${enc}/avatar`
        : null

  if (!trimmed || phase === 2) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md bg-muted/80',
          className
        )}
      >
        <span className="text-xs font-semibold text-muted-foreground">
          {initials.slice(0, 2).toUpperCase()}
        </span>
      </div>
    )
  }

  return (
    <img
      src={src ?? undefined}
      alt=""
      className={cn('shrink-0 rounded-md object-cover', className)}
      onError={handleError}
      loading="lazy"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
    />
  )
}
