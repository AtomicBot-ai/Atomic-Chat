import { cn } from '@/lib/utils'
import { ReactNode } from 'react'

type CardProps = {
  /** DOM id, so a link can scroll to the card (`/launch#<agent-id>`). */
  id?: string
  title?: string
  children?: ReactNode
  header?: ReactNode
  className?: string
}

type CardItemProps = {
  title?: string | ReactNode
  description?: string | ReactNode
  descriptionOutside?: string | ReactNode
  align?: 'start' | 'center' | 'end'
  actions?: ReactNode
  column?: boolean
  className?: string
  classNameWrapperAction?: string
}

export function CardItem({
  title,
  description,
  descriptionOutside,
  className,
  classNameWrapperAction,
  align = 'center',
  column,
  actions,
}: CardItemProps) {
  return (
    <>
      <div
        className={cn(
          'flex justify-between mt-3 first:mt-0 border-b border-border/40 pb-3 last:border-none last:pb-0 gap-5',
          descriptionOutside && 'border-0',
          align === 'start' && 'items-start',
          align === 'center' && 'items-center',
          align === 'end' && 'items-end',
          column && 'flex-col gap-y-0 items-start',
          className
        )}
      >
        <div className="min-w-0 space-y-1.5">
          <h1 className="font-medium text-foreground">{title}</h1>
          {description && (
            <span className="text-muted-foreground leading-normal">
              {description}
            </span>
          )}
        </div>
        {actions && (
          <div
            className={cn(
              'shrink-0',
              classNameWrapperAction,
              column && 'w-full'
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {descriptionOutside && (
        <span className="text-muted-foreground leading-normal">
          {descriptionOutside}
        </span>
      )}
    </>
  )
}

export function Card({ id, title, children, header, className }: CardProps) {
  return (
    <div
      id={id}
      className={cn(
        'content-card px-4 py-3.5 text-muted-foreground w-full min-w-0 border border-border bg-card rounded-xl',
        className
      )}
    >
      {title && (
        <h1 className="text-foreground font-studio font-medium text-base mb-3">
          {title}
        </h1>
      )}
      {header && header}
      {children}
    </div>
  )
}
