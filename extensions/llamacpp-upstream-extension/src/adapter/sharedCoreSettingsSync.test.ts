/** The shared settings handover the TurboQuant, MLX and Foundation Models extensions use. */
import { describe, expect, it, vi } from 'vitest'

import { createCoreSettingsSync, stableSettingsFingerprint } from '../../../shared/atomicCoreSettingsSync'
import type { PersistedSetting } from '../../../shared/atomicCoreSettingsSync'

function harness(
  overrides: {
    status?: unknown
    importStatus?: string
    coreValues?: Record<string, unknown>
    persisted?: PersistedSetting[]
  } = {}
) {
  const order: string[] = []
  let persisted: PersistedSetting[] = overrides.persisted ?? [
    { key: 'ctx_size', controllerProps: { value: 4096 } },
    { key: 'kv_bits', controllerProps: { value: 3.5 } },
    { key: 'unset', controllerProps: {} },
  ]
  const mirroring: boolean[] = []
  const core = {
    getStatus: vi.fn(async () => overrides.status ?? { attached: { instance_id: 'i', generation: 1 } }),
    importSettings: vi.fn(async (values: Record<string, unknown>) => {
      order.push(`import ${JSON.stringify(values)}`)
      return { status: overrides.importStatus ?? 'imported', applied: [], conflicts: [{ key: 'ctx_size' }], revision: 3 }
    }),
    getSettings: vi.fn(async () => ({ provider: 'mlx', revision: 7, values: overrides.coreValues ?? { ctx_size: 8192 } })),
    acknowledgeSettings: vi.fn(async (revision: number) => {
      order.push(`ack ${revision}`)
    }),
  }
  const sync = createCoreSettingsSync({
    core: core as never,
    readSettings: async () => structuredClone(persisted),
    writeSettings: async (settings) => {
      order.push(`write mirroring=${mirroring.at(-1)}`)
      persisted = settings
    },
    setMirroring: (active) => mirroring.push(active),
    beforeMirror: async (values) => {
      order.push(`before ${JSON.stringify(values)}`)
    },
    afterMirror: async (changed) => {
      order.push(`after ${JSON.stringify(changed)}`)
    },
  })
  return { sync, core, order, mirroring, persisted: () => persisted }
}

describe('shared core settings sync', () => {
  it('imports, mirrors under the guard and acknowledges after the write; hardware is the core’s own', async () => {
    const h = harness()
    await h.sync.ensureReady()
    expect(h.order).toEqual([
      'import {"ctx_size":4096,"kv_bits":3.5}',
      'before {"ctx_size":8192}',
      'write mirroring=true',
      'ack 7',
      'after {"ctx_size":8192}',
    ])
    expect(h.mirroring).toEqual([true, false])
    expect(h.persisted()[0]?.controllerProps.value).toBe(8192)
  })

  it('prepares once per attachment and settings state, and again when either changes', async () => {
    const h = harness({ coreValues: { ctx_size: 4096 } })
    const cycle = [
      'import {"ctx_size":4096,"kv_bits":3.5}',
      'before {"ctx_size":4096}',
      'write mirroring=true',
      'ack 7',
      'after {}',
    ]
    await h.sync.ensureReady()
    await h.sync.ensureReady()
    expect(h.core.importSettings).toHaveBeenCalledTimes(1)
    // The second call reuses the first preparation: no second mirror write or acknowledgement
    // reaches the core or the persisted settings.
    expect(h.order).toEqual(cycle)
    h.core.getStatus.mockResolvedValue({ attached: { instance_id: 'i', generation: 2 } })
    await h.sync.ensureReady()
    expect(h.core.importSettings).toHaveBeenCalledTimes(2)
    // A new core generation runs the whole handover again, not only the import.
    expect(h.order).toEqual([...cycle, ...cycle])
  })

  it('refuses without an attachment, on a conflict and on a failed import, and forgets the failure', async () => {
    await expect(harness({ status: { attached: null } }).sync.ensureReady()).rejects.toThrow('no ready attachment')
    const conflict = harness({ importStatus: 'conflict' })
    await expect(conflict.sync.ensureReady()).rejects.toThrow('Atomic core settings conflict: ctx_size')
    conflict.core.importSettings.mockRejectedValueOnce({ code: 'IO_ERROR', message: 'disk' })
    await expect(conflict.sync.ensureReady()).rejects.toThrow('Atomic core settings import failed: disk [IO_ERROR]')
    expect(conflict.core.importSettings).toHaveBeenCalledTimes(2)
  })

  it('mirrors on demand and acknowledges each mirror', async () => {
    const h = harness()
    await h.sync.ensureReady()
    await h.sync.mirror()
    expect(h.order.filter((line) => line.startsWith('ack'))).toHaveLength(2)
  })

  // Change unify-engine-lifecycle (6.3): the core writes `version_backend` on an update or an
  // activation. The extension takes the value, and its next load hands the core nothing older.
  it('takes a value the core changed and imports nothing older on the next load', async () => {
    const h = harness({
      persisted: [{ key: 'version_backend', controllerProps: { value: 'b1/macos-arm64' } }],
      coreValues: { version_backend: 'b1/macos-arm64' },
    })
    await h.sync.ensureReady()
    h.order.length = 0

    // Another client updated the engine: `settings:changed` → mirror.
    h.core.getSettings.mockResolvedValue({
      provider: 'llamacpp',
      revision: 8,
      values: { version_backend: 'b2/macos-arm64' },
    })
    await h.sync.mirror()
    await h.sync.ensureReady()

    expect(h.persisted()[0]?.controllerProps.value).toBe('b2/macos-arm64')
    expect(h.order).toEqual([
      'before {"version_backend":"b2/macos-arm64"}',
      'write mirroring=true',
      'ack 8',
      'after {"version_backend":"b2/macos-arm64"}',
    ])
    expect(h.core.importSettings).toHaveBeenCalledTimes(1)
  })

  it('lets a load that starts while a mirror runs wait for it instead of importing the old value', async () => {
    const h = harness({
      persisted: [{ key: 'version_backend', controllerProps: { value: 'b1/macos-arm64' } }],
      coreValues: { version_backend: 'b2/macos-arm64' },
    })
    const mirroring = h.sync.mirror()
    await h.sync.ensureReady()
    await mirroring

    const imports = h.core.importSettings.mock.calls.map(([values]) => values)
    expect(imports).not.toContainEqual({ version_backend: 'b1/macos-arm64' })
    expect(h.persisted()[0]?.controllerProps.value).toBe('b2/macos-arm64')
  })

  it('fingerprints settings independently of key order and undefined fields', () => {
    expect(stableSettingsFingerprint({ b: 1, a: { d: undefined, c: [1] } })).toBe(stableSettingsFingerprint({ a: { c: [1] }, b: 1 }))
  })
})
