import { useRef } from 'react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  COMPOSER_DEFAULT_WIDTH,
  COMPOSER_MIN_ROWS,
  useComposerLayout,
} from '@/stores/composer-layout-store'

const ROW_PX = 24 // text-sm / leading-6

/**
 * A grip in the composer's bottom-right corner. Dragging changes how wide and
 * how tall the box is, within the limits in the layout store; double-click puts
 * it back. The box is centred, so the width moves by twice the pointer travel to
 * keep the grip under the cursor.
 */
export function ComposerResizeHandle({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const setSize = useComposerLayout((state) => state.setSize)
  const resetSize = useComposerLayout((state) => state.resetSize)
  const drag = useRef<{ x: number; y: number; width: number; rows: number } | null>(null)

  return (
    <div
      role="separator"
      aria-label={t('chat:resize', { defaultValue: 'Drag to resize the chat box (double-click to reset)' })}
      title={t('chat:resize', { defaultValue: 'Drag to resize the chat box (double-click to reset)' })}
      data-no-hover-glow
      data-testid="composer-resize-handle"
      className="absolute right-1.5 bottom-1.5 z-30 flex size-4 cursor-nwse-resize touch-none items-end justify-end text-muted-foreground/60 hover:text-foreground"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const { width, rows } = useComposerLayout.getState()
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          width: width ?? containerRef.current?.offsetWidth ?? COMPOSER_DEFAULT_WIDTH,
          rows: Math.max(rows, COMPOSER_MIN_ROWS),
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        // Never taller than most of the window, so the send button and the
        // toolbar stay on screen however long the prompt gets.
        const maxRows = Math.floor((window.innerHeight * 0.6) / ROW_PX)
        setSize(
          start.width + (event.clientX - start.x) * 2,
          Math.min(maxRows, start.rows + (event.clientY - start.y) / ROW_PX)
        )
      }}
      onPointerUp={(event) => {
        drag.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onDoubleClick={resetSize}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M9 3 3 9M9 6.5 6.5 9" />
      </svg>
    </div>
  )
}
