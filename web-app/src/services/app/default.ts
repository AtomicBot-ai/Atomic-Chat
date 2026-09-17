/**
 * Default App Service - Generic implementation with minimal returns
 */

import type { AppService, LogEntry } from './types'
import type { AutostartPreference } from '@janhq/core'
import {
  REMOTE_ACCESS_OFF,
  type RemoteAccessStatus,
} from '@/types/remoteAccess'

export class DefaultAppService implements AppService {
  async factoryReset(): Promise<void> {
    // No-op
  }

  async readLogs(): Promise<LogEntry[]> {
    return []
  }

  parseLogLine(line: string): LogEntry {
    return {
      timestamp: Date.now(),
      level: 'info',
      target: 'default',
      message: line ?? '',
    }
  }

  async getJanDataFolder(): Promise<string | undefined> {
    return undefined
  }

  async relocateJanDataFolder(path: string): Promise<void> {
    console.log('relocateJanDataFolder called with path:', path)
    // No-op - not implemented in default service
  }

  async getAutostartPreference(): Promise<AutostartPreference> {
    return 'unmanaged'
  }

  async setAutostartPreference(
    preference: AutostartPreference
  ): Promise<void> {
    void preference
  }

  async getServerStatus(): Promise<boolean> {
    return false
  }

  async readYaml<T = unknown>(path: string): Promise<T> {
    console.log('readYaml called with path:', path)
    throw new Error('readYaml not implemented in default app service')
  }

  async getInstallerType(): Promise<string | undefined> {
    return undefined
  }

  // Remote & LAN access is desktop only. Web has no tunnel to report on, so
  // these stay inert: always off, nothing to start, no addresses.
  async getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
    return REMOTE_ACCESS_OFF
  }

  async startRemoteAccess(): Promise<RemoteAccessStatus> {
    return REMOTE_ACCESS_OFF
  }

  async stopRemoteAccess(): Promise<RemoteAccessStatus> {
    return REMOTE_ACCESS_OFF
  }

  async getLanAddresses(): Promise<string[]> {
    return []
  }
}
