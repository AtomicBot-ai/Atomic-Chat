import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

// The official IPC mock swallows `plugin:event|unlisten`, so the detach path
// can only be observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriModelSetupService, RESET_EVENT } = await import('../tauri')
const { DefaultModelSetupService } = await import('../default')

type Call = { method: string; path: string; body: unknown }

const pack = { version: 'prism-b9100-1234567', backend: 'macos-arm64' }

describe('TauriModelSetupService commands', () => {
  let calls: Call[]

  beforeEach(() => {
    calls = []
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      switch (`${call.method} ${call.path}`) {
        case 'POST /models/compatibility':
          return { outcome: 'engine_required', provider: 'atomic-prism' }
        case 'GET /models/atomic-prism/families':
          return { rules_version: 3, families: [] }
        case 'POST /backends/atomic-prism/catalog':
          return { installed: [], available: [pack], recommended: null }
        case 'POST /disk/available':
          return { bytes: 5_000 }
        case 'POST /backends/atomic-prism/install':
          return { ...pack, installed: true, path: '/p' }
        case 'POST /engines/atomic-prism/builds/prism-b9100-1234567/macos-arm64/activate':
          return {
            activated: true,
            active: { version: pack.version, variant: pack.backend },
          }
        default:
          throw new Error(`unexpected ${call.method} ${call.path}`)
      }
    })
  })

  it('asks the core for the Bonsai families the Hub lists', async () => {
    const service = new TauriModelSetupService()

    await expect(service.families()).resolves.toEqual({
      rules_version: 3,
      families: [],
    })
    expect(calls).toEqual([
      { method: 'GET', path: '/models/atomic-prism/families', body: null },
    ])
  })

  it('reaches the compatibility, catalog, disk and engine routes, and no setup route', async () => {
    const service = new TauriModelSetupService()
    const file = { repo: 'prism-ml/Bonsai', file: 'm.gguf' }

    expect(service.isSupported()).toBe(true)
    expect(
      await service.checkCompatibility({ ...file, inspect_remote: true })
    ).toMatchObject({ outcome: 'engine_required' })
    expect(await service.prismCatalog()).toMatchObject({ available: [pack] })
    expect(await service.diskAvailable()).toBe(5_000)
    await service.installPrismBuild(pack, 'engine-build-atomic-prism-t')
    await service.activatePrismBuild(pack)

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/compatibility',
        body: { ...file, inspect_remote: true },
      },
      {
        method: 'POST',
        path: '/backends/atomic-prism/catalog',
        body: { app_version: 'test', proxy: null },
      },
      { method: 'POST', path: '/disk/available', body: {} },
      {
        method: 'POST',
        path: '/backends/atomic-prism/install',
        body: { ...pack, task_id: 'engine-build-atomic-prism-t', proxy: null },
      },
      {
        method: 'POST',
        path: '/engines/atomic-prism/builds/prism-b9100-1234567/macos-arm64/activate',
        body: null,
      },
    ])
  })
})

describe('TauriModelSetupService.onCoreReset', () => {
  beforeEach(() => {
    // A bare `listen.mockReset()` would return the mock, which Vitest runs as
    // a cleanup callback — and a pending `listen()` promise then hangs the hook.
    listen.mockReset()
  })

  it('hears only the relay snapshot: a new core generation attached', async () => {
    const handlers = new Map<string, () => void>()
    listen.mockImplementation(async (name: string, handler: () => void) => {
      handlers.set(name, handler)
      return () => {}
    })
    const reset = vi.fn()
    new TauriModelSetupService().onCoreReset(reset)
    await Promise.resolve()

    expect([...handlers.keys()]).toEqual([RESET_EVENT])
    handlers.get(RESET_EVENT)!()
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('detaches its listener once, even when unsubscribed twice', async () => {
    const unlisten = vi.fn()
    listen.mockImplementation(async () => unlisten)

    const unsubscribe = new TauriModelSetupService().onCoreReset(() => {})
    unsubscribe()
    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlisten.mock.calls.length).toBe(1)
  })
})

describe('DefaultModelSetupService', () => {
  it('is unsupported, rejects every call and hears nothing', async () => {
    const service = new DefaultModelSetupService()
    const file = { repo: 'o/r', file: 'f.gguf' }
    expect(service.isSupported()).toBe(false)
    await expect(service.checkCompatibility(file)).rejects.toThrow(
      /not available/
    )
    await expect(service.families()).rejects.toThrow(/not available/)
    await expect(service.prismCatalog()).rejects.toThrow(/not available/)
    await expect(service.diskAvailable()).rejects.toThrow(/not available/)
    await expect(service.installPrismBuild(pack, 't')).rejects.toThrow(
      /not available/
    )
    await expect(service.activatePrismBuild(pack)).rejects.toThrow(
      /not available/
    )
    expect(service.onCoreReset(() => {})()).toBeUndefined()
  })
})
