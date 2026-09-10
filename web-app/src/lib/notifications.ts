import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'

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

export async function notifyThreadCompleted(
  title: string,
  body: string
): Promise<void> {
  console.info(`${LOG_PREFIX} notifyThreadCompleted called`, {
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
