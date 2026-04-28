import { useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { isPlatformTauri } from '@/lib/platform/utils'

type Options = {
  enabled: boolean
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: (paths: string[]) => void
}

/**
 * Subscribe to Tauri's native drag-and-drop events for the current webview.
 *
 * Requires `dragDropEnabled: true` in `tauri.<platform>.conf.json` (the
 * change requires restarting the Tauri binary to take effect). On non-Tauri
 * platforms this hook is a no-op and the browser's HTML5 handlers continue
 * to work.
 *
 * The position payload from Tauri is intentionally ignored: any drop into
 * the application window is forwarded to the chat input. Hit-testing CSS
 * rectangles against physical-pixel positions across DPR-scaled displays
 * and frameless windows is brittle, and users expect "drop anywhere" UX.
 */
export const useTauriDragDrop = ({
  enabled,
  onDragOver,
  onDragLeave,
  onDrop,
}: Options): void => {
  const onDragOverRef = useRef(onDragOver)
  const onDragLeaveRef = useRef(onDragLeave)
  const onDropRef = useRef(onDrop)

  useEffect(() => {
    onDragOverRef.current = onDragOver
    onDragLeaveRef.current = onDragLeave
    onDropRef.current = onDrop
  }, [onDragOver, onDragLeave, onDrop])

  useEffect(() => {
    if (!enabled || !isPlatformTauri()) return

    let cancelled = false
    let unlisten: (() => void) | null = null

    const setup = async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload
          switch (payload.type) {
            case 'enter':
            case 'over':
              onDragOverRef.current()
              break
            case 'drop':
              onDragLeaveRef.current()
              if (payload.paths.length > 0) {
                onDropRef.current([...payload.paths])
              }
              break
            case 'leave':
              onDragLeaveRef.current()
              break
          }
        })
        if (cancelled) {
          unlisten?.()
          unlisten = null
        }
      } catch (e) {
        console.error('Failed to attach Tauri drag-drop listener', e)
      }
    }

    void setup()

    return () => {
      cancelled = true
      if (unlisten) {
        try {
          unlisten()
        } catch (e) {
          console.warn('Failed to detach Tauri drag-drop listener', e)
        }
      }
    }
  }, [enabled])
}
