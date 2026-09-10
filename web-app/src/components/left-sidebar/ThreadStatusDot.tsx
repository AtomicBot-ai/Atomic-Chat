import { cn } from '@/lib/utils'

type ThreadStatusDotProps = {
  pulsing?: boolean
}

export function ThreadStatusDot({ pulsing = false }: ThreadStatusDotProps) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full bg-primary',
        pulsing && 'animate-pulse'
      )}
      aria-hidden
    />
  )
}
