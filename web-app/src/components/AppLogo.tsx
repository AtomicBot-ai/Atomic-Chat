import { cn } from '@/lib/utils'

type AppLogoProps = {
  className?: string
  /** Colour class for the wordmark; the sidebar paints it in its own token. */
  wordmarkClassName?: string
}

/**
 * The product lockup — the tile and the "Radium" wordmark — as one component.
 * The sidebar and the first-run screen both show it, and showing the same
 * element is the only way to keep the two from drifting apart in size: two
 * hand-copied tiles read as "different" the moment a padding changes on one of
 * them.
 *
 * The wordmark is text in the studio face rather than a drawing, so a later
 * rename is a text change that tests and searches can see; the drawn
 * "Atomic Chat" wordmark it replaces was missed by the first rename.
 */
export function AppLogo({ className, wordmarkClassName }: AppLogoProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <img
        src="/images/transparent-logo.png"
        alt="Radium"
        title="Radium"
        className="size-9 shrink-0 rounded-lg object-contain"
        draggable={false}
      />
      <span
        className={cn(
          'shrink-0 font-studio text-xl font-semibold leading-none tracking-tight',
          wordmarkClassName
        )}
      >
        Radium
      </span>
    </div>
  )
}
