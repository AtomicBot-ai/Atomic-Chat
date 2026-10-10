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

export interface CoreSettingsSyncOptions {
  core: Pick<CoreRuntime, 'getStatus' | 'importSettings' | 'getSettings' | 'acknowledgeSettings'>
  readSettings: () => Promise<PersistedSetting[]>
  writeSettings: (settings: PersistedSetting[]) => Promise<void>
  /**
   * Set while the mirror writes: `updateSettings` calls the extension's `onSettingUpdate` for every
   * descriptor, and a mirror must not start owner-side work such as a backend download.
   */
  setMirroring: (active: boolean) => void
  /**
   * Before a mirror reads and writes the extension's settings, with the core's values: a value the
   * extension cannot show yet (a `version_backend` the core switched to that is not among the
   * dropdown options) is made showable here, so the write keeps it.
   */
  beforeMirror?: (values: Record<string, unknown>) => Promise<void> | void
  /** After a mirror was written and acknowledged, with the values it changed in the extension. */
  afterMirror?: (changed: Record<string, unknown>) => Promise<void> | void
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
  let ready: { attachment: string; fingerprint: string; promise: Promise<void> } | undefined
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
    await options.beforeMirror?.(snapshot.values)
    const changed: Record<string, unknown> = {}
    const mirrored = (await options.readSettings()).map((setting) => {
      if (Object.prototype.hasOwnProperty.call(snapshot.values, setting.key)) {
        const value = snapshot.values[setting.key]
        if (stableSettingsFingerprint({ v: setting.controllerProps.value }) !== stableSettingsFingerprint({ v: value }))
          changed[setting.key] = value
        setting.controllerProps.value = value
      }
      return setting
    })
    options.setMirroring(true)
    try {
      await options.writeSettings(mirrored)
    } finally {
      options.setMirroring(false)
    }
    // What was just written is the core's own: the next load must not import it back as the
    // app's change, let alone an older value from before the write.
    if (ready) ready = { ...ready, fingerprint: stableSettingsFingerprint(await currentValues()) }
    await options.core.acknowledgeSettings(snapshot.revision)
    await options.afterMirror?.(changed)
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
  }

  /**
   * Import and mirror once per core attachment and settings state. A new core generation or a
   * changed setting prepares again; a failure is not remembered. Hardware facts are the core's own
   * since ADR 2026-09-27; nothing is sent.
   */
  async function ensureReady(): Promise<void> {
    // A mirror in flight is writing the core's values: read them once it is done.
    await mirrorChain
    const [values, status] = await Promise.all([currentValues(), options.core.getStatus()])
    const attached = status.attached
    if (!attached?.instance_id || attached.generation === undefined)
      throw new Error('Atomic core has no ready attachment generation')
    const attachment = `${attached.instance_id}:${attached.generation}`
    const fingerprint = stableSettingsFingerprint(values)
    if (ready?.attachment === attachment && ready.fingerprint === fingerprint) return ready.promise
    const promise = prepare(values)
    ready = { attachment, fingerprint, promise }
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
