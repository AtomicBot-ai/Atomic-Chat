import { Toaster } from '@/components/ui/sonner'
import { hasCustomWindowChrome } from '@/lib/window-chrome'

/** Height of the window strip WindowFrame draws (h-8). */
const WINDOW_STRIP_HEIGHT = 32

export function ToasterProvider() {
  return (
    <Toaster
      richColors
      closeButton
      position="top-right"
      // Where Radium draws its own Minimize, Maximize and Close, notifications
      // start below that strip; at 8px from the top they covered the buttons
      // and swallowed their clicks (2026-09-14).
      offset={{
        top: (hasCustomWindowChrome() ? WINDOW_STRIP_HEIGHT : 0) + 8,
        right: 8,
      }}
      toastOptions={{
        style: {
          background: 'var(--background)',
          padding: '1rem 0.8rem',
          alignItems: 'center',
          borderColor: 'var(--border)',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
        },
        classNames: {
          toast: 'toast select-none',
          title: 'text-foreground! select-none',
          description: 'text-muted-foreground! select-none',
          closeButton:
            '!border-border !bg-background text-foreground hover:!bg-muted',
        },
      }}
    />
  )
}
