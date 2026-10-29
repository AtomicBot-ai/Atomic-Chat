import { forwardRef, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The geometry the Images, Videos and Audios studios share: the form column
 * on the left, the media pane on the right, the whole window tall.
 */
export function MediaStudioFrame({
  children,
  testId,
}: {
  children: ReactNode
  testId: string
}) {
  return (
    <div
      className="grid h-svh w-full grid-cols-[minmax(340px,400px)_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden"
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/** The card that holds a studio's model picker, prompt and Generate. */
export function MediaPromptCard({
  children,
  testId,
}: {
  children: ReactNode
  testId: string
}) {
  return (
    <div
      className="space-y-2.5 rounded-2xl border bg-secondary/20 p-2.5"
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/** The pill at the top of `MediaPromptCard` that opens the model list. */
export const MediaModelPickerButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'>
>(function MediaModelPickerButton({ className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border bg-background px-2.5 text-sm transition-colors duration-150 ease-out hover:bg-secondary/50 active:scale-[0.99]',
        className
      )}
      {...props}
    />
  )
})
