import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

/**
 * Whether this window draws its own title bar - Minimize, Maximize and Close.
 *
 * The Windows main window is created without native decorations
 * (`decorations: false` in src-tauri/tauri.windows.conf.json), so without
 * this the app has no way to be moved, minimised, maximised or closed. Every
 * other window keeps its native frame.
 */
export function hasCustomWindowChrome(): boolean {
  if (!IS_TAURI || !IS_WINDOWS) return false
  try {
    return getCurrentWebviewWindow().label === 'main'
  } catch {
    return false
  }
}
