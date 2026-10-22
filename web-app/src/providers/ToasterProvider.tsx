import { Toaster } from '@/components/ui/sonner'

/** Space between a toast and the edges it is anchored to. */
const TOAST_EDGE_GAP = 8

/**
 * Height of the window title bar row (`--window-titlebar-height` on the app
 * shell in `routes/__root.tsx`, drawn by `components/left-sidebar/WindowTitlebar`).
 * The row is fixed to the top of every desktop window and, with the macOS
 * overlay title bar, carries the traffic lights and the window drag region,
 * so a toast pinned to the very top would sit on it and lose the top of its
 * close button. The toaster is mounted outside the shell, so it cannot read
 * the variable and keeps its own copy of the number.
 */
const WINDOW_TITLEBAR_HEIGHT = 42

export function ToasterProvider() {
  // Web and mobile builds keep the toaster at the top edge.
  const isDesktop = IS_MACOS || IS_WINDOWS || IS_LINUX
  return (
    <Toaster
      richColors
      closeButton
      position="top-right"
      offset={{
        top: isDesktop
          ? WINDOW_TITLEBAR_HEIGHT + TOAST_EDGE_GAP
          : TOAST_EDGE_GAP,
        right: TOAST_EDGE_GAP,
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
