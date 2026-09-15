import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import type { DeviceList } from '@/services/hardware/types'
import { useModelProvider } from './useModelProvider'

interface LlamacppDevicesStore {
  devices: (DeviceList & { activated: boolean })[]
  loading: boolean
  error: string | null

  // Actions
  fetchDevices: () => Promise<void>
  clearError: () => void
  setDevices: (devices: (DeviceList & { activated: boolean })[]) => void
  toggleDevice: (deviceId: string) => void
}

export const useLlamacppDevices = create<LlamacppDevicesStore>((set, get) => ({
  devices: [],
  loading: false,
  error: null,

  fetchDevices: async () => {
    set({ loading: true, error: null })

    try {
      const devices = await getServiceHub().hardware().getLlamacppDevices()
      
      // Check current device setting from provider.
      //
      // Must be the provider the device list actually came from:
      // `getLlamacppDevices()` asks LOCAL_LLAMACPP_EXTENSION_NAME
      // (`@janhq/llamacpp-upstream-extension`, see services/hardware/tauri.ts),
      // so the `device` setting that gates those ids lives on
      // LOCAL_LLAMACPP_PROVIDER. Reading the hardcoded turboquant `llamacpp`
      // provider annotated the upstream devices with a setting no running
      // model ever reads — and on Windows/Linux, where the turboquant
      // extension is not bundled at all (ADR 2026-05-22), with nothing.
      const { getProviderByName } = useModelProvider.getState()
      const llamacppProvider = getProviderByName(LOCAL_LLAMACPP_PROVIDER)
      const currentDeviceSetting = llamacppProvider?.settings.find(
        (s) => s.key === 'device'
      )?.controller_props.value as string

      // Parse device setting from extension which represents activated devices
      const activatedDevices = currentDeviceSetting 
        ? currentDeviceSetting.split(',').map(d => d.trim()).filter(Boolean)
        : []

      const devicesWithActivation = devices.map((device) => ({
        ...device,
        activated:
          // Empty device setting means all devices are activated
          !currentDeviceSetting || currentDeviceSetting === '' || activatedDevices.includes(device.id),
      }))

      set({ devices: devicesWithActivation, loading: false })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to fetch devices'
      set({ error: errorMessage, loading: false })
    }
  },

  clearError: () => set({ error: null }),

  setDevices: (devices) => set({ devices }),

  toggleDevice: async (deviceId: string) => {
    // Toggle device activation in the local state
    set((state) => ({
      devices: state.devices.map((device) =>
        device.id === deviceId
          ? { ...device, activated: !device.activated }
          : device
      ),
    }))

    // Update llamacpp provider settings — same provider the ids came from.
    const { getProviderByName, updateProvider } = useModelProvider.getState()
    const llamacppProvider = getProviderByName(LOCAL_LLAMACPP_PROVIDER)

    if (llamacppProvider) {
      // Get activated devices after toggle
      const activatedDeviceIds = get().devices
        .filter((device) => device.activated)
        .map((device) => device.id)

      const deviceString = activatedDeviceIds.join(',')

      const updatedSettings = llamacppProvider.settings.map((setting) => {
        if (setting.key === 'device') {
          return {
            ...setting,
            controller_props: {
              ...setting.controller_props,
              value: deviceString.length > 0 ? deviceString : 'none',
            },
          }
        }
        return setting
      })

      await getServiceHub()
        .providers()
        .updateSettings(LOCAL_LLAMACPP_PROVIDER, updatedSettings)
      updateProvider(LOCAL_LLAMACPP_PROVIDER, {
        settings: updatedSettings,
      })
    }
  },

}))
