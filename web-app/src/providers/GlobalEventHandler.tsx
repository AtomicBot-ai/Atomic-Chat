import { useEffect } from 'react'
import { AppEvent, events } from '@janhq/core'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useHardware } from '@/hooks/useHardware'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  useBackendMismatch,
  type BackendRuntimeEvent,
} from '@/hooks/useBackendMismatch'

/**
 * GlobalEventHandler handles global events that should be processed across all screens
 * This provider should be mounted at the root level to ensure all screens can benefit from global event handling
 */
export function GlobalEventHandler() {
  const { setProviders } = useModelProvider()
  const serviceHub = useServiceHub()
  const setHardwareData = useHardware((state) => state.setHardwareData)
  const { report: reportBackendMismatch } = useBackendMismatch()

  useEffect(() => {
    if (!isPlatformTauri()) return

    let cancelled = false

    const loadHardwareInfo = async () => {
      try {
        const data = await serviceHub.hardware().getHardwareInfo()
        if (!cancelled && data) {
          setHardwareData(data)
        }
      } catch (error) {
        console.error('Failed to load hardware info on startup:', error)
      }
    }

    loadHardwareInfo()

    return () => {
      cancelled = true
    }
  }, [serviceHub, setHardwareData])

  // Re-detect GPU when app becomes visible again (e.g. after system sleep on Linux - #6447)
  useEffect(() => {
    if (!isPlatformTauri()) return

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        await serviceHub.hardware().refreshHardwareInfo()
        const data = await serviceHub.hardware().getHardwareInfo()
        if (data) setHardwareData(data)
      } catch (e) {
        console.error('Failed to refresh hardware info after visibility change:', e)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [serviceHub, setHardwareData])

  // Handle settingsChanged event globally
  useEffect(() => {
    const handleSettingsChanged = async (event: {
      key: string
      value: string
    }) => {
      console.log('Global settingsChanged event:', event)

      // Handle version_backend changes specifically
      if (event.key === 'version_backend') {
        try {
          // Refresh providers to get updated settings from the extension
          const updatedProviders = await serviceHub.providers().getProviders()
          setProviders(updatedProviders)
          console.log('Providers refreshed after version_backend change')
        } catch (error) {
          console.error(
            'Failed to refresh providers after settingsChanged:',
            error
          )
        }
      }

      // Add more global event handlers here as needed
      // For example:
      // if (event.key === 'some_other_setting') {
      //   // Handle other setting changes
      // }
    }

    // Subscribe to the settingsChanged event
    events.on('settingsChanged', handleSettingsChanged)

    // Cleanup subscription on unmount
    return () => {
      events.off('settingsChanged', handleSettingsChanged)
    }
  }, [setProviders, serviceHub])

  // Verdict on what a finished load actually ran on. A mismatch is only
  // recorded here — the prompt is raised on the next message send so a load is
  // never interrupted — and a healthy verdict retires an earlier warning.
  useEffect(() => {
    const handleBackendRuntime = (event: BackendRuntimeEvent) => {
      if (event.mismatch.kind !== 'ok') {
        console.warn('Backend mismatch detected:', event)
      }
      reportBackendMismatch(event)
    }

    events.on(AppEvent.onBackendRuntimeReported, handleBackendRuntime)
    return () => {
      events.off(AppEvent.onBackendRuntimeReported, handleBackendRuntime)
    }
  }, [reportBackendMismatch])

  // This component doesn't render anything
  return null
}
