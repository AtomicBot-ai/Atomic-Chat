import { useCallback } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'

/**
 * Let the user point the local-model scanner at a folder of their own.
 *
 * The folder picker and the "remember it in Settings" step used to live only
 * in Settings → General, so a user whose models sit in a directory of their
 * choosing found out about "Add folder" only by going looking for it. The
 * composer's widget now offers the same thing at the moment it matters
 * (ATO-458); both go through here so a folder added from either place is
 * scanned on every later launch.
 */
export function useLocalScanFolder(): {
  /** Opens the OS folder picker; returns the chosen path, or `null`. */
  pickScanFolder: () => Promise<string | null>
} {
  const serviceHub = useServiceHub()
  const addFolder = useGeneralSetting((s) => s.addLocalScanFolder)

  const pickScanFolder = useCallback(async () => {
    try {
      const selected = await serviceHub.dialog().open({
        multiple: false,
        directory: true,
      })
      if (typeof selected !== 'string' || selected.length === 0) return null
      addFolder?.(selected)
      return selected
    } catch (error) {
      console.error('Failed to pick scan folder:', error)
      return null
    }
  }, [serviceHub, addFolder])

  return { pickScanFolder }
}
