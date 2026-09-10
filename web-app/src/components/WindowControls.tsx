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
    <div
      className={cn(
        'absolute top-0 z-50 h-15',
        isMaximized ? 'right-0' : 'right-4'
      )}
    >
      <div
        className={cn('flex h-full', isMaximized ? 'items-stretch' : 'items-center')}
      >
        <Button
          onClick={handleMinimize}
          aria-label="Minimize"
          variant="ghost"
          size="icon-sm"
          className={cn(isMaximized && 'h-full')}
        >
          <Minus className="size-4" />
        </Button>
        <Button
          onClick={handleMaximize}
          variant="ghost"
          size="icon-sm"
          aria-label="Maximize"
          className={cn(isMaximized && 'h-full')}
        >
          <Square className="size-3" />
        </Button>
        <Button
          onClick={handleClose}
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          className={cn(
            isMaximized && 'h-full rounded-none hover:rounded-none'
          )}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
