import { useCallback } from 'react'
import { toast } from 'sonner'

import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { EngineId } from '@/services/engines/types'
import { activateEngineBuildThroughCore } from '@/services/engines/update'

/** One setting's value replaced, the rest as they were. */
function withValue(
  settings: ProviderSetting[],
  key: string,
  value: string
): ProviderSetting[] {
  return settings.map((setting) =>
    setting.key === key
      ? {
          ...setting,
          controller_props: { ...setting.controller_props, value },
        }
      : setting
  )
}

/**
 * The installed build picked in a llama.cpp provider's version list (spec
 * `engine-lifecycle-desktop`, "Выбор сборки llama.cpp делает core"). The core
 * makes it active: it writes `version_backend` and unloads this provider's
 * models under the same lock an update takes. The page writes no version and
 * stops no model itself.
 *
 * The list shows the pick at once; if the core refuses, it goes back to the
 * build that was active and says why. Once the core switched, a GPU device
 * chosen for the old build is cleared, as a version change always did: its
 * names belong to the old build's family.
 */
export function useVersionBackendActivation(providerName: string) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const choose = useCallback(
    async (value: string) => {
      const [version, variant, ...rest] = value.trim().split('/')
      if (!version || !variant || rest.length > 0) return
      const store = useModelProvider.getState()
      const provider = store.getProviderByName(providerName)
      if (!provider) return
      const previous = provider.settings.find(
        (setting) => setting.key === 'version_backend'
      )?.controller_props.value
      const show = (shown: string) => {
        const current = useModelProvider
          .getState()
          .getProviderByName(providerName)
        if (!current) return
        useModelProvider.getState().updateProvider(providerName, {
          ...current,
          settings: withValue(current.settings, 'version_backend', shown),
        })
      }

      show(value)
      try {
        await activateEngineBuildThroughCore(
          providerName as EngineId,
          version,
          variant
        )
      } catch (error) {
        if (typeof previous === 'string') show(previous)
        const message = (error as { message?: unknown } | null)?.message
        toast.error(t('settings:backendUpdater.activateFailed'), {
          description: typeof message === 'string' ? message : String(error),
        })
        return
      }

      const device = useModelProvider
        .getState()
        .getProviderByName(providerName)
        ?.settings.find((setting) => setting.key === 'device')
      if (device && device.controller_props.value) {
        const cleared = {
          ...device,
          controller_props: { ...device.controller_props, value: '' },
        }
        const current = useModelProvider
          .getState()
          .getProviderByName(providerName)
        if (current) {
          useModelProvider.getState().updateProvider(providerName, {
            ...current,
            settings: withValue(current.settings, 'device', ''),
          })
        }
        void serviceHub.providers().updateSettings(providerName, [cleared])
      }
      if (providerName === 'llamacpp') {
        // Device activations follow the build.
        void useLlamacppDevices.getState().fetchDevices()
      }
    },
    [providerName, serviceHub, t]
  )

  return { choose }
}
