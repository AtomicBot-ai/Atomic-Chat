import { Minus, Square, X } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useHeaderOverlay } from '@/stores/header-overlay-store'
import { useCallback, useEffect, useState } from 'react'

export const WindowControls = () => {
  const appWindow = getCurrentWebviewWindow()
  const [isMaximized, setIsMaximized] = useState(false)
  const cornerButtons = useHeaderOverlay((state) => state.rightOverlayButtons)

  const refreshMaximized = useCallback(async () => {
    setIsMaximized(await appWindow.isMaximized())
  }, [appWindow])

  useEffect(() => {
    void refreshMaximized()

    let cancelled = false
    let detach: (() => Promise<void>) | null = null

    const setup = async () => {
      try {
        const unlisten = await appWindow.onResized(() => {
          void refreshMaximized()
        })
        detach = createSafeUnlisten(unlisten)
        if (cancelled) await detach()
      } catch (e) {
        console.error('Failed to attach window resize listener', e)
      }
    }

    void setup()

    return () => {
      cancelled = true
      void detach?.()
    }
  }, [appWindow, refreshMaximized])

  const handleMinimize = async () => {
    await appWindow.minimize()
  }

  const handleMaximize = async () => {
    await appWindow.toggleMaximize()
    await refreshMaximized()
  }

  const handleClose = async () => {
    await appWindow.close()
  }

  return (
    // In the page header's top row (h-15), just left of the agent workspace's
    // corner buttons: 32px each, 8px apart and 12px off the window edge, which
    // report how many are showing to the header overlay store.
    <div
      role="group"
      aria-label="Window controls"
      className="absolute top-0 z-50 flex h-15 items-center gap-1"
      style={{ right: 12 + cornerButtons * 40 }}
    >
      <Button
        onClick={handleMinimize}
        aria-label="Minimize"
        variant="ghost"
        size="icon-sm"
        className="h-9 w-11 rounded-md"
      >
        <Minus className="size-4" />
      </Button>
      <Button
        onClick={handleMaximize}
        variant="ghost"
        size="icon-sm"
        aria-label="Maximize"
        className="h-9 w-11 rounded-md"
      >
        <Square className={cn('size-3', isMaximized && 'scale-90')} />
      </Button>
      <Button
        onClick={handleClose}
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        className="h-9 w-11 rounded-md hover:bg-red-500 hover:text-white"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
