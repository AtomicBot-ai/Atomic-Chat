import { useEffect } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import {
  syncEmailReminder,
  useEmailReminderStore,
} from '@/stores/email-reminder-store'

/** Runs independently of the wait screen, including after Explore or a restart. */
export function useEmailReminderSync(): void {
  const reminder = useEmailReminderStore((state) => state.reminder)
  const providers = useModelProvider((state) => state.providers)

  useEffect(() => {
    if (reminder?.status !== 'waiting') return
    const sync = () => {
      // Storage can become unavailable. Leave the durable intent intact and
      // try later; neither tokens nor addresses belong in diagnostics.
      void syncEmailReminder(useModelProvider.getState().providers).catch(
        () => undefined
      )
    }
    sync()
    const timer = setInterval(sync, 60_000)
    window.addEventListener('online', sync)
    window.addEventListener('focus', sync)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', sync)
      window.removeEventListener('focus', sync)
    }
  }, [reminder, providers])
}
