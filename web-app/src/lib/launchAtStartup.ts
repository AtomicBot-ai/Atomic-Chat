import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import type { AppService } from '@/services/app/types'
import type { AutostartPreference } from '@janhq/core'

type AutostartPreferenceStore = Pick<
  AppService,
  'getAutostartPreference' | 'setAutostartPreference'
>

const preferenceForState = (enabled: boolean): AutostartPreference =>
  enabled ? 'enabled' : 'disabled'

export async function reconcileLaunchAtStartup(
  appService: AutostartPreferenceStore
): Promise<boolean> {
  const preference = await appService.getAutostartPreference()
  let enabled = await isAutostartEnabled()

  if (preference === 'pending_default_on') {
    if (!enabled) {
      await enableAutostart()
      enabled = await isAutostartEnabled()
    }
    if (!enabled) {
      throw new Error('Operating system did not enable launch at startup')
    }
  }

  const resolvedPreference = preferenceForState(enabled)
  if (preference !== resolvedPreference) {
    await appService.setAutostartPreference(resolvedPreference)
  }

  return enabled
}

export async function setLaunchAtStartup(
  appService: AutostartPreferenceStore,
  enabled: boolean
): Promise<boolean> {
  if (enabled) {
    await enableAutostart()
  } else {
    await disableAutostart()
  }

  const actualState = await isAutostartEnabled()
  if (actualState !== enabled) {
    throw new Error('Operating system did not apply launch-at-startup setting')
  }

  await appService.setAutostartPreference(preferenceForState(actualState))
  return actualState
}
