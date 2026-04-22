import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

let permissionPromise: Promise<boolean> | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionPromise) return permissionPromise
  permissionPromise = (async () => {
    try {
      if (await isPermissionGranted()) return true
      const result = await requestPermission()
      return result === 'granted'
    } catch (error) {
      console.error('Failed to resolve notification permission', error)
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
  if (!IS_TAURI) return
  try {
    const granted = await ensurePermission()
    if (!granted) return
    sendNotification({ title, body })
  } catch (error) {
    console.error('Failed to send thread completion notification', error)
  }
}
