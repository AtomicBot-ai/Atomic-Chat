import type { ReactNode } from 'react'

import { WindowControls } from '@/components/WindowControls'
import { hasCustomWindowChrome } from '@/lib/window-chrome'

/**
 * Minimize, Maximize and Close for windows that have no native title bar (see
 * `hasCustomWindowChrome`). There is no separate bar: at the user's request
 * (2026-09-14) the controls sit in the page's own top row, which HeaderPage
 * keeps clear for them and makes a drag region. Anywhere else this renders its
 * children untouched.
 *
 * Kept out of routes/__root.tsx on purpose. That file is upstream's, and an
 * upstream sync once replaced it wholesale and silently dropped these controls;
 * a single `<WindowFrame>` there is easier to keep, and
 * tests/window-controls.test.mjs fails if it goes missing.
 */
export function WindowFrame({ children }: { children: ReactNode }) {
  if (!hasCustomWindowChrome()) return <>{children}</>

  return (
    <div className="relative size-full">
      {children}
      <WindowControls />
    </div>
  )
}
