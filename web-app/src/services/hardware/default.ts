/**
 * Default Hardware Service - Generic implementation with minimal returns
 */

import type { HardwareData, SystemUsage, DeviceList, HardwareService } from './types'

export class DefaultHardwareService implements HardwareService {
  async getHardwareInfo(): Promise<HardwareData | null> {
    return null
  }

  async getSystemUsage(): Promise<SystemUsage | null> {
    return null
  }

  async getLlamacppDevices(): Promise<DeviceList[]> {
    return []
  }

  async refreshHardwareInfo(): Promise<void> {
    // No-op outside Tauri (e.g. web)
  }
}
