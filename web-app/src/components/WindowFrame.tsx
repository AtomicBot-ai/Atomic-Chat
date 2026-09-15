import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { WindowControls } from '@/components/WindowControls'
import { hasCustomWindowChrome } from '@/lib/window-chrome'

/**
 * The title bar for windows that have no native one (see `hasCustomWindowChrome`):
 * a drag region, the window's title and the Minimize, Maximize and Close
 * buttons. Anywhere else it renders its children untouched.
 *
 * Kept out of routes/__root.tsx on purpose. That file is upstream's, and an
 * upstream sync once replaced it wholesale and silently dropped these controls;
 * a single `<WindowFrame>` there is easier to keep, and
 * tests/window-controls.test.mjs fails if it goes missing.
 */
export function WindowFrame({ children }: { children: ReactNode }) {
  const customChrome = hasCustomWindowChrome()
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!customChrome) return
    let cancelled = false
    // The configured window title, so this follows the product name instead of
    // carrying its own copy of it.
    getCurrentWebviewWindow()
      .title()
      .then((value) => {
        if (!cancelled) setTitle(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [customChrome])

  if (!customChrome) return <>{children}</>

  return (
    // `data-window-chrome` scopes the index.css rules that shorten full-height
    // layouts and move the sidebar below this bar, so nothing is cut off.
    <div
      data-window-chrome
      className="relative size-full overflow-hidden bg-neutral-50 dark:bg-background"
    >
      {/* Above everything the app can draw: notifications (z-index 999999999),
          full-screen viewers and drop-downs. Anything on top of the strip
          swallows clicks meant for Minimize, Maximize and Close - the user
          found them dead on some pages (2026-09-14).
          tests/window-controls.test.mjs keeps it the highest.
          Open pop-ups and drop-down menus also switch off clicks on the whole
          page (`pointer-events: none` on <body>), which took these buttons
          with them; the inline style switches them back on for the strip. */}
      <div
        className="absolute inset-x-0 top-0 z-[2147483646] h-8 bg-background/95 backdrop-blur"
        style={{ pointerEvents: 'auto' }}
      >
        <div
          className="absolute inset-0 right-[132px]"
          data-tauri-drag-region
        />
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-medium text-muted-foreground"
          data-tauri-drag-region
        >
          {title}
        </div>
        <WindowControls />
      </div>
      <div className="size-full pt-8">{children}</div>
    </div>
  )
}
