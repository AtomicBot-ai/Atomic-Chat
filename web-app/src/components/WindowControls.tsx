import { Minus, Square, X } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useCallback, useEffect, useState } from 'react'

export const WindowControls = () => {
  const appWindow = getCurrentWebviewWindow()
  const [isMaximized, setIsMaximized] = useState(false)

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
    <div className="absolute right-0 top-0 z-50 h-8">
      <div className="flex h-full items-stretch">
        <Button
          onClick={handleMinimize}
          aria-label="Minimize"
          variant="ghost"
          size="icon-sm"
          className="h-full w-11 rounded-none"
        >
          <Minus className="size-4" />
        </Button>
        <Button
          onClick={handleMaximize}
          variant="ghost"
          size="icon-sm"
          aria-label="Maximize"
          className="h-full w-11 rounded-none"
        >
          <Square className={cn('size-3', isMaximized && 'scale-90')} />
        </Button>
        <Button
          onClick={handleClose}
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          className="h-full w-11 rounded-none hover:bg-red-500 hover:text-white"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
