import { localStorageKey } from '@/constants/localStorage'
import { useEffect, useState } from 'react'

export const SETUP_COMPLETED_EVENT = 'app:setup-completed'

/// Tracks the `setup-completed` localStorage flag. Used to defer mounting
/// `<BackendUpdater />` until the dedicated onboarding flow finishes (during
/// onboarding the SetupBackendStep handles backend recommendations inline, so
/// the global dialog would surface a duplicate modal on top of the setup
/// screen), and to gate the bottom-right onboarding model reminder.
export function useSetupCompleted(): boolean {
  const [completed, setCompleted] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(localStorageKey.setupCompleted) === 'true'
  })

  useEffect(() => {
    const sync = () => {
      setCompleted(
        localStorage.getItem(localStorageKey.setupCompleted) === 'true'
      )
    }
    // Same-tab signal dispatched explicitly by SetupScreen when it persists
    // the flag (the native 'storage' event only fires across tabs).
    window.addEventListener(SETUP_COMPLETED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(SETUP_COMPLETED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  return completed
}
