import { useCallback } from 'react'

import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import type {
  EngineActivateResult,
  EngineId,
  EngineVersions,
} from '@/services/engines/types'
import { activateEngineBuildThroughCore } from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/** The providers whose builds are llama.cpp packs the client picks through the core. */
export function isLlamacppProvider(providerName: string): boolean {
  return (
    providerName === 'llamacpp' ||
    providerName === 'llamacpp-upstream' ||
    providerName === 'atomic-prism'
  )
}

type Option = { value: number | string; name: string }

/**
 * What "Install another build…" offers: the extension's version list without
 * what the core lists as installed (switching between those is the installed
 * builds list's "Make active"). A concrete `<version>/<variant>` stays only
 * when it is not on disk; a `latest/<variant>` stays unless it would name the
 * build already active — the core's newest for this host, of that variant.
 * Before the core answered, nothing counts as installed: an update to a build
 * on disk is only a switch.
 */
export function installableOptions(
  entry: EngineVersions | undefined,
  options: Option[]
): Option[] {
  const installed = new Set(
    (entry?.builds ?? []).map((build) => `${build.version}/${build.variant}`)
  )
  const { active, latest } = entry ?? {}
  return options.filter((option) => {
    if (typeof option.value !== 'string') return false
    const value = option.value.replace(/\uFEFF/g, '').trim()
    const [version, variant, ...rest] = value.split('/')
    if (!version || !variant || rest.length > 0) return false
    if (version === 'latest')
      return !(
        active &&
        latest &&
        latest.variant === variant &&
        active.variant === variant &&
        active.version === latest.version
      )
    return !installed.has(value)
  })
}

/**
 * After the user moved a llama.cpp provider to another build ("Make active",
 * "Install another build…"): a GPU device chosen for the old build is
 * cleared, as a version change always did — its names belong to the old
 * build's family — and the TurboQuant device list is read again. The core
 * wrote `version_backend` and unloaded the models; the page writes only the
 * device.
 */
export function useClearDeviceAfterSwitch(providerName: string) {
  const serviceHub = useServiceHub()
  return useCallback(() => {
    const provider = useModelProvider.getState().getProviderByName(providerName)
    const device = provider?.settings.find(
      (setting) => setting.key === 'device'
    )
    if (provider && device && device.controller_props.value) {
      const cleared = {
        ...device,
        controller_props: { ...device.controller_props, value: '' },
      }
      useModelProvider.getState().updateProvider(providerName, {
        ...provider,
        settings: provider.settings.map((setting) =>
          setting.key === 'device' ? cleared : setting
        ),
      })
      void serviceHub.providers().updateSettings(providerName, [cleared])
    }
    if (providerName === 'llamacpp') {
      // Device activations follow the build.
      void useLlamacppDevices.getState().fetchDevices()
    }
  }, [providerName, serviceHub])
}

/**
 * A build installed from a file is made active by the core, as "Make active"
 * makes one: the core writes `version_backend` and unloads the provider's
 * models; the extension only unpacked it. `null` when the extension did not
 * name a `<version>/<variant>`. The installed builds list is asked again either
 * way, since the disk changed without an `engine:changed`.
 */
export async function activateInstalledBuild(
  engine: EngineId,
  installed: string | undefined
): Promise<EngineActivateResult | null> {
  try {
    const [version, variant, ...rest] = (installed ?? '')
      .replace(/\uFEFF/g, '')
      .trim()
      .split('/')
    if (!version || !variant || rest.length > 0) return null
    return await activateEngineBuildThroughCore(engine, version, variant)
  } finally {
    void useEngineVersionsStore.getState().refresh()
  }
}
