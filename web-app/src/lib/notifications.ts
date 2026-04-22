import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
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
    console.info(`${LOG_PREFIX} sendNotification →`, { title, body })
    sendNotification({ title, body })
  } catch (error) {
    console.error(`${LOG_PREFIX} sendNotification failed`, error)
  }
}
