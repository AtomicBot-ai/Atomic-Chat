/**
 * Tauri App Service - Desktop implementation
 */

import { invoke } from '@tauri-apps/api/core'
import { type AppConfiguration, type AutostartPreference } from '@janhq/core'
import {
  BACKEND_PRESERVE_KEYS,
  localStorageKey,
} from '@/constants/localStorage'
import type { LogEntry } from './types'
import { DefaultAppService } from './default'
import { normalizeRemoteAccessStatus } from '@/lib/remoteLan'
import type { RemoteAccessStatus } from '@/types/remoteAccess'

/**
 * One relayed control call. A `REMOTE_ACCESS_*` refusal from the core carries
 * the reason the page has always parsed (`server_stopped`, …) in `details`;
 * it is rethrown bare so `parseRemoteAccessRejection` reads it as before.
 */
async function coreCall<T = unknown>(
  method: 'GET' | 'POST',
  path: string
): Promise<T> {
  try {
    return await invoke<T>('atomic_core_call', { method, path, body: null })
  } catch (error) {
    const record =
      error && typeof error === 'object'
        ? (error as { code?: unknown; details?: unknown })
        : null
    if (
      record &&
      typeof record.code === 'string' &&
      record.code.startsWith('REMOTE_ACCESS_') &&
      typeof record.details === 'string'
    ) {
      throw record.details
    }
    throw error
  }
}

/**
 * A reply that is not a status is a contract break, not "off": reject with a
 * code so the card reports it instead of showing a tunnel state it made up.
 */
function expectRemoteAccessStatus(raw: unknown): RemoteAccessStatus {
  const status = normalizeRemoteAccessStatus(raw)
  if (!status) throw new Error('malformed_status')
  return status
}

export class TauriAppService extends DefaultAppService {
  async factoryReset(): Promise<void> {
    const { EngineManager } = await import('@janhq/core')
    for (const [, engine] of EngineManager.instance().engines) {
      const activeModels = await engine.getLoadedModels()
      if (activeModels) {
        await Promise.all(activeModels.map((model: string) => engine.unload(model)))
      }
    }

    const savedBackend: Record<string, string> = {}
    for (const key of BACKEND_PRESERVE_KEYS) {
      const val = window.localStorage.getItem(key)
      if (val) savedBackend[key] = val
    }

    window.localStorage.clear()

    for (const [key, val] of Object.entries(savedBackend)) {
      window.localStorage.setItem(key, val)
    }

    window.localStorage.setItem(localStorageKey.factoryResetPending, 'true')
    await invoke('factory_reset')
  }

  async readLogs(): Promise<LogEntry[]> {
    const logData: string = (await invoke('read_logs')) ?? ''
    return logData.split('\n').map(this.parseLogLine)
  }

  async getInstallerType(): Promise<string | undefined> {
    try {
      const value = (await invoke('get_installer_type')) as string | null
      return value ?? undefined
    } catch (error) {
      console.debug('get_installer_type unavailable:', error)
      return undefined
    }
  }

  async getJanDataFolder(): Promise<string | undefined> {
    try {
      const appConfiguration: AppConfiguration | undefined =
        await window.core?.api?.getAppConfigurations()

      return appConfiguration?.data_folder
    } catch (error) {
      console.error('Failed to get Jan data folder:', error)
      return undefined
    }
  }

  async relocateJanDataFolder(path: string): Promise<void> {
    await window.core?.api?.changeAppDataFolder({ newDataFolder: path })
  }

  async getAutostartPreference(): Promise<AutostartPreference> {
    const configuration: AppConfiguration =
      await window.core?.api?.getAppConfigurations()
    return configuration.autostart_preference ?? 'unmanaged'
  }

  async setAutostartPreference(preference: AutostartPreference): Promise<void> {
    const configuration: AppConfiguration =
      await window.core?.api?.getAppConfigurations()
    configuration.autostart_preference = preference
    await window.core?.api?.updateAppConfiguration({ configuration })
  }

  parseLogLine(line: string): LogEntry {
    const regex = /^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\s(.*)$/
    const match = line.match(regex)

    if (!match)
      return {
        timestamp: Date.now(),
        level: 'info' as 'info' | 'warn' | 'error' | 'debug',
        target: 'info',
        message: line ?? '',
      } as LogEntry

    const [, date, time, target, levelRaw, message] = match

    const level = levelRaw.toLowerCase() as 'info' | 'warn' | 'error' | 'debug'
    const utcTime = time.endsWith('Z') ? time : `${time}Z`

    return {
      timestamp: `${date}T${utcTime}`,
      level,
      target,
      message,
    }
  }

  async getServerStatus(): Promise<boolean> {
    return await invoke<boolean>('get_server_status')
  }

  async readYaml<T = unknown>(path: string): Promise<T> {
    return await invoke<T>('read_yaml', { path })
  }

  // Desktop-only, served by the core; `PlatformFeature.LOCAL_API_SERVER`
  // gates every caller, so mobile never reaches them.
  async getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
    return expectRemoteAccessStatus(await coreCall('GET', '/remote-access'))
  }

  async startRemoteAccess(): Promise<RemoteAccessStatus> {
    return expectRemoteAccessStatus(
      await coreCall('POST', '/remote-access/start')
    )
  }

  async stopRemoteAccess(): Promise<RemoteAccessStatus> {
    return expectRemoteAccessStatus(
      await coreCall('POST', '/remote-access/stop')
    )
  }

  async getLanAddresses(): Promise<string[]> {
    const reply = await coreCall<{ addresses?: unknown }>('GET', '/lan-addresses')
    const addresses = reply && typeof reply === 'object' ? reply.addresses : null
    return Array.isArray(addresses)
      ? addresses.filter(
          (address): address is string => typeof address === 'string'
        )
      : []
  }
}
