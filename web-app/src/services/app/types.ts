/**
 * App Service Types
 */

import type { AutostartPreference } from '@janhq/core'

export interface LogEntry {
  timestamp: string | number
  level: 'info' | 'warn' | 'error' | 'debug'
  target: string
  message: string
}

/** Where local models are saved to and read from. */
export interface ModelsFolderInfo {
  path: string
  default_path: string
  is_default: boolean
}

/** What happened to the models already downloaded when the folder changed. */
export interface ModelsFolderMoveReport {
  moved: string[]
  /** Left behind because the new folder already has one by that name. */
  skipped: string[]
  failed: [string, string][]
}

export interface AppService {
  getModelsFolder(): Promise<ModelsFolderInfo | undefined>
  /** `null` goes back to the default folder inside the data folder. */
  setModelsFolder(
    path: string | null,
    moveExisting: boolean
  ): Promise<ModelsFolderMoveReport>
  factoryReset(): Promise<void>
  readLogs(): Promise<LogEntry[]>
  parseLogLine(line: string): LogEntry
  getJanDataFolder(): Promise<string | undefined>
  relocateJanDataFolder(path: string): Promise<void>
  getAutostartPreference(): Promise<AutostartPreference>
  setAutostartPreference(preference: AutostartPreference): Promise<void>
  getServerStatus(): Promise<boolean>
  readYaml<T = unknown>(path: string): Promise<T>
  /** Best-effort installer channel of the running build (ATO-111 telemetry). */
  getInstallerType(): Promise<string | undefined>
}
