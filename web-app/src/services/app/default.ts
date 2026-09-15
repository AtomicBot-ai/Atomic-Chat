/**
 * Default App Service - Generic implementation with minimal returns
 */

import type {
  AppService,
  LogEntry,
  ModelsFolderInfo,
  ModelsFolderMoveReport,
} from './types'
import type { AutostartPreference } from '@janhq/core'

export class DefaultAppService implements AppService {
  async getModelsFolder(): Promise<ModelsFolderInfo | undefined> {
    return undefined
  }

  async setModelsFolder(
    path: string | null,
    moveExisting: boolean
  ): Promise<ModelsFolderMoveReport> {
    void path
    void moveExisting
    throw new Error('Choosing a models folder needs the desktop app')
  }

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
}
