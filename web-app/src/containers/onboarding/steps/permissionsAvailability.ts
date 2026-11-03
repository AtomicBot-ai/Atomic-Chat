import { useEffect, useState } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import type { MicPermission } from '@/services/voice/types'

/** What the permissions step can ask this machine for. */
export type PermissionAvailability = {
  /** Desktop notifications: only the desktop app has an OS to ask. */
  notifications: boolean
  /**
   * The microphone as the OS reports it now, read without prompting; `null`
   * until it has answered. `unsupported` — no voice input in this build, or
   * an OS that manages the microphone outside the app — leaves the row out.
   */
  microphone: MicPermission | null
}

/**
 * Reads what the permissions step can offer. The microphone answer is the
 * voice service's, the same one voice input asks before it records.
 */
export function usePermissionAvailability(): PermissionAvailability {
  const voice = useServiceHub().voice()
  const supported = voice.isSupported()
  const [microphone, setMicrophone] = useState<MicPermission | null>(
    supported ? null : 'unsupported'
  )

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    voice
      .getPermission()
      .then((permission) => {
        if (!cancelled) setMicrophone(permission)
      })
      .catch((error: unknown) => {
        // A plugin that cannot answer cannot prompt either.
        console.warn('[onboarding] microphone permission unreadable', error)
        if (!cancelled) setMicrophone('unsupported')
      })
    return () => {
      cancelled = true
    }
  }, [voice, supported])

  return {
    notifications: IS_TAURI && !IS_IOS && !IS_ANDROID,
    microphone,
  }
}

/**
 * Permissions this platform can actually ask for, as rows of the permissions
 * step; a machine with none skips the step (`lib/onboarding/steps`).
 */
export function usePermissionRowCount(): number {
  const { notifications, microphone } = usePermissionAvailability()
  const microphoneRow = microphone !== null && microphone !== 'unsupported'
  return Number(notifications) + Number(microphoneRow)
}
