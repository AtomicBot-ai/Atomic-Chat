import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { useThreadNotifications } from '@/hooks/useThreadNotifications'

const LOG_PREFIX = '[notifications]'

let permissionPromise: Promise<boolean> | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionPromise) return permissionPromise
  permissionPromise = (async () => {
    try {
      const alreadyGranted = await isPermissionGranted()
      console.info(`${LOG_PREFIX} isPermissionGranted →`, alreadyGranted)
      if (alreadyGranted) return true
      const result = await requestPermission()
      console.info(`${LOG_PREFIX} requestPermission →`, result)
      return result === 'granted'
    } catch (error) {
      console.error(`${LOG_PREFIX} permission flow failed`, error)
      return false
    }
  })()
  const granted = await permissionPromise
  // Cache only positive outcomes; allow retry if the user denied initially.
  if (!granted) permissionPromise = null
  return granted
}

/** Whether the OS already lets the app notify. Never shows a prompt. */
export async function notificationPermissionGranted(): Promise<boolean> {
  if (!IS_TAURI) return false
  try {
    return await isPermissionGranted()
  } catch (error) {
    console.error(`${LOG_PREFIX} isPermissionGranted failed`, error)
    return false
  }
}

/**
 * Asks the OS for notification access ahead of the first notification, as
 * the first-run flow does. Resolves `true` once granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!IS_TAURI) return false
  return ensurePermission()
}

/** Sends an OS notification; callers decide whether one is wanted. */
export async function showDesktopNotification(
  title: string,
  body: string
): Promise<void> {
  console.info(`${LOG_PREFIX} showDesktopNotification called`, {
    IS_TAURI,
    title,
    body,
  })
  if (!IS_TAURI) {
    console.warn(`${LOG_PREFIX} skipped: not a Tauri runtime`)
    return
  }
  try {
    const granted = await ensurePermission()
    if (!granted) {
      console.warn(`${LOG_PREFIX} skipped: OS permission not granted`)
      return
    }
    console.info(`${LOG_PREFIX} show_desktop_notification →`, { title, body })
    // Deliberately not the plugin's sendNotification: its async `notify`
    // command runs blocking D-Bus delivery on a tokio worker and aborts the
    // app on Linux (nested-runtime panic). Our command uses spawn_blocking.
    await invoke('show_desktop_notification', { title, body })
  } catch (error) {
    console.error(`${LOG_PREFIX} show_desktop_notification failed`, error)
  }
}

/**
 * The Settings master switch. Undefined (pre-feature or lost during
 * rehydration) counts as ON, so only an explicit OFF silences notifications.
 */
export function desktopNotificationsEnabled(): boolean {
  return useThreadNotifications.getState().globallyEnabled !== false
}

/** Hidden, minimized or another app in front: the user is not looking. */
export function isWindowAway(): boolean {
  if (typeof document === 'undefined') return false
  if (document.visibilityState !== 'visible') return true
  // On macOS a background Tauri window stays "visible"; hasFocus() tells.
  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

/**
 * Something the user waited for is done (a download, images, a clip). Tell the
 * OS only while they are away and the master switch is on — in a focused
 * window the in-app toast or the studio already shows it. Returns whether the
 * OS was asked.
 */
export function notifyWhenAway(title: string, body: string): boolean {
  if (!desktopNotificationsEnabled() || !isWindowAway()) return false
  void showDesktopNotification(title, body)
  return true
}
