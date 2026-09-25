/**
 * Handing a provider's settings to `atomic-chat-core` before its first core-owned load, and keeping
 * the extension's copy current afterwards (PLAN.md §3.4, stage 5).
 *
 * The llama.cpp upstream extension grew this inline in stage 3b; the TurboQuant, MLX and Foundation
 * Models extensions share this copy. Like the adapter it imports nothing: the extension passes the
 * few things only it can do — read and write its persisted settings, measure the hardware.
 *
 * Why each step exists:
 *  - *import* — until a provider's settings are imported, this app's copy is the truth, and a core
 *    load would use the core's defaults instead of the user's values;
 *  - *mirror, then acknowledge* — the extension's persisted copy is the rollback copy: if ownership
 *    goes back to the app it must hold what the core was running with. Acknowledge is sent only
 *    after the copy is written, so the core never believes a rollback copy exists that does not;
 *  - *hardware override* — backend selection is decided by NVML and Vulkan facts only the app can
 *    measure.
 *
 * A conflict (both sides changed a value) blocks the first core load: continuing would acknowledge
 * neither side while handing the runtime over, and a later rollback would silently use stale values.
 */

import type { CoreRuntime } from './atomicCoreRuntime'
import { describeCoreError } from './atomicCoreRuntime'

export interface PersistedSetting {
  key: string
  controllerProps: { value?: unknown }
}

export interface HardwareFacts {
  gpus?: unknown[]
  cpu?: { extensions?: string[] }
  os_type?: string
}

export interface CoreSettingsSyncOptions {
  core: Pick<CoreRuntime, 'getStatus' | 'importSettings' | 'getSettings' | 'acknowledgeSettings' | 'sendHardwareOverride'>
  readSettings: () => Promise<PersistedSetting[]>
  writeSettings: (settings: PersistedSetting[]) => Promise<void>
  /**
   * Set while the mirror writes: `updateSettings` calls the extension's `onSettingUpdate` for every
   * descriptor, and a mirror must not start owner-side work such as a backend download.
   */
  setMirroring: (active: boolean) => void
  /** Hardware facts for the core; omitted by a provider whose runtime does not select a backend. */
  systemInfo?: () => Promise<HardwareFacts | undefined>
}

/** Key order and `undefined` fields do not make two settings objects different. */
export function stableSettingsFingerprint(values: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    )
  }
  return JSON.stringify(stable(values))
}

export function createCoreSettingsSync(options: CoreSettingsSyncOptions) {
  let ready: { key: string; promise: Promise<void> } | undefined
  let mirrorChain: Promise<void> = Promise.resolve()

  async function currentValues(): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {}
    for (const setting of await options.readSettings()) {
      const value = setting.controllerProps?.value
      if (value !== undefined) values[setting.key] = value
    }
    return values
  }

  async function mirrorNow(): Promise<void> {
    const snapshot = await options.core.getSettings()
    const mirrored = (await options.readSettings()).map((setting) => {
      if (Object.prototype.hasOwnProperty.call(snapshot.values, setting.key))
        setting.controllerProps.value = snapshot.values[setting.key]
      return setting
    })
    options.setMirroring(true)
    try {
      await options.writeSettings(mirrored)
    } finally {
      options.setMirroring(false)
    }
    await options.core.acknowledgeSettings(snapshot.revision)
  }

  /** Mirror the core's values into the extension, one mirror at a time. */
  function mirror(): Promise<void> {
    const next = mirrorChain.then(mirrorNow)
    mirrorChain = next.catch(() => {})
    return next
  }

  async function prepare(values: Record<string, unknown>): Promise<void> {
    let result: Awaited<ReturnType<CoreSettingsSyncOptions['core']['importSettings']>>
    try {
      result = await options.core.importSettings(values)
    } catch (error) {
      throw new Error(`Atomic core settings import failed: ${describeCoreError(error)}`)
    }
    if (result.status === 'conflict')
      throw new Error(`Atomic core settings conflict: ${result.conflicts.map((c) => c.key).join(', ')}`)
    await mirror()
    if (options.systemInfo) {
      const info = await options.systemInfo()
      await options.core.sendHardwareOverride({
        gpus: info?.gpus ?? [],
        ...(info?.cpu?.extensions ? { cpu_extensions: info.cpu.extensions } : {}),
        ...(info?.os_type ? { os_type: info.os_type } : {}),
      })
    }
  }

  /**
   * Import, mirror and send hardware facts once per core attachment and settings state. A new core
   * generation or a changed setting prepares again; a failure is not remembered.
   */
  async function ensureReady(): Promise<void> {
    const [values, status] = await Promise.all([currentValues(), options.core.getStatus()])
    const attachment = status.attached
    if (!attachment?.instance_id || attachment.generation === undefined)
      throw new Error('Atomic core has no ready attachment generation')
    const key = `${attachment.instance_id}:${attachment.generation}:${stableSettingsFingerprint(values)}`
    if (ready?.key === key) return ready.promise
    const promise = prepare(values)
    ready = { key, promise }
    try {
      await promise
    } catch (error) {
      if (ready?.promise === promise) ready = undefined
      throw error
    }
  }

  return { ensureReady, mirror }
}

export type CoreSettingsSync = ReturnType<typeof createCoreSettingsSync>
