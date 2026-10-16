import { useEffect, useState } from 'react'
import { initializeServiceHub } from '@/services'
import { initializeServiceHubStore } from '@/hooks/useServiceHub'
import { BootLogLevel, bootLog, bootStep } from '@/lib/boot'

interface ServiceHubProviderProps {
  children: React.ReactNode
}

export function ServiceHubProvider({ children }: ServiceHubProviderProps) {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    bootStep('services', 'Loading services…')
    const startedAt = Date.now()
    initializeServiceHub()
      .then((hub) => {
        console.log('Services initialized, initializing Zustand store')
        initializeServiceHubStore(hub)
        bootLog(`services ready in ${Date.now() - startedAt} ms`)
        setIsReady(true)
      })
      .catch((error) => {
        console.error('Service initialization failed:', error)
        bootLog(
          `service initialization failed after ${Date.now() - startedAt} ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
          BootLogLevel.error
        )
        setIsReady(true) // Still render to show error state
      })
  }, [])

  return <>{isReady && children}</>
}
