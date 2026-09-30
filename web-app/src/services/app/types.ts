/**
 * App Service Types
 */

import type { AutostartPreference } from '@janhq/core'
import type { RemoteAccessStatus } from '@/types/remoteAccess'

export interface LogEntry {
  timestamp: string | number
  level: 'info' | 'warn' | 'error' | 'debug'
  target: string
  message: string
}

export interface AppService {
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
  /**
   * Settings → Remote & LAN. Desktop only: the Cloudflare tunnel in front of
   * the Local API Server is owned by Rust, these only ask it to move.
   * `startRemoteAccess` resolves as soon as the tunnel is `starting` and
   * rejects with `server_stopped` when there is no server to expose; the
   * outcome arrives on the `remote-access:status` event.
   */
  getRemoteAccessStatus(): Promise<RemoteAccessStatus>
  startRemoteAccess(): Promise<RemoteAccessStatus>
  /** Can take ~10 s when the tunnel process has to be killed. */
  stopRemoteAccess(): Promise<RemoteAccessStatus>
  /** IPv4 addresses to show, default-route address first. May be empty. */
  getLanAddresses(): Promise<string[]>
}
