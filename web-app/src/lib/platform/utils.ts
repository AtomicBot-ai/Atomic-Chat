import { Platform, PlatformFeature } from './types'

declare const IS_WEB_APP: boolean
declare const IS_IOS: boolean
declare const IS_ANDROID: boolean

/**
 * True when the Tauri IPC bridge is actually reachable.
 *
 * `IS_WEB_APP` is a build-time define and cannot describe where the bundle
 * ends up running: `tauri dev` serves the very same desktop bundle over
 * http://localhost:1420, so opening that URL in a normal browser produced a
 * build where every `isPlatformTauri()` guard passed while
 * `window.__TAURI_INTERNALS__` was missing. Every downstream `invoke` /
 * `listen` then threw `Cannot read properties of undefined`. Probing the
 * bridge itself is the only check that holds in both cases.
 */
const hasTauriBridge = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const isPlatformTauri = (): boolean => {
  if (
    typeof IS_WEB_APP !== 'undefined' &&
    (IS_WEB_APP === true || (IS_WEB_APP as unknown as string) === 'true')
  ) {
    return false
  }
  return hasTauriBridge()
}

export const isPlatformIOS = (): boolean => {
  return IS_IOS
}

export const isPlatformAndroid = (): boolean => {
  return IS_ANDROID
}

export const isIOS = (): boolean => isPlatformIOS()

export const isAndroid = (): boolean => isPlatformAndroid()

export const getCurrentPlatform = (): Platform => {
  if (isPlatformIOS()) return 'ios'
  if (isPlatformAndroid()) return 'android'
  return isPlatformTauri() ? 'tauri' : 'web'
}

export const getUnavailableFeatureMessage = (
  feature: PlatformFeature
): string => {
  const platform = getCurrentPlatform()
  const featureName = feature
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .replace(/^./, (str) => str.toUpperCase())
  return `${featureName} is not available on ${platform} platform`
}
