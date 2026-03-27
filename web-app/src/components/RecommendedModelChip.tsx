import type { RecommendedModelChipVariant } from '@/constants/recommendedModelChip'
import { cn } from '@/lib/utils'

//* Чип метки рекомендации (Untitled UI Label)
const variantClassName: Record<RecommendedModelChipVariant, string> = {
  gray:
    'border-gray-200 bg-gray-50 text-gray-700 dark:border-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-200',
  green:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  blue:
    'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200',
  purple:
    'border-purple-200 bg-purple-50 text-purple-800 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-200',
  yellow:
    'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950/45 dark:text-yellow-200',
}

type RecommendedModelChipProps = {
  children: React.ReactNode
  className?: string
  title?: string
  variant?: RecommendedModelChipVariant
}

export function RecommendedModelChip({
  children,
  className,
  title,
  variant = 'gray',
}: RecommendedModelChipProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[22px] max-w-44 shrink-0 items-center justify-center truncate rounded-[6px] border border-solid px-[6px] py-0.5 text-center text-xs font-medium sm:max-w-56',
        variantClassName[variant],
        className
      )}
      title={title}
    >
      {children}
    </span>
  )
}
