import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { APIs } from '@/lib/service'
import { TauriCoreService } from '../core/tauri'
import { TauriAppService } from '../app/tauri'
import { seedServiceHub } from '@/test/service-hub'

const engineMocks = vi.hoisted(() => ({
  getLoadedModels: vi.fn().mockResolvedValue(['model1', 'model2']),
  unload: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@janhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janhq/core')>()
  return {
    ...actual,
    EngineManager: {
      instance: () => ({
        engines: new Map([['engine1', engineMocks]]),
      }),
    },
  }
})

describe('TauriAppService', () => {
  let appService: TauriAppService
  let ipcHandler: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    ipcHandler = vi.fn()
    mockIPC((command: string, args?: InvokeArgs) => ipcHandler(command, args))
    seedServiceHub({ core: new TauriCoreService() })
    window.core = {
      api: APIs,
      extensionManager: undefined,
    }
    appService = new TauriAppService()
    window.localStorage.clear()
  })

  describe('parseLogLine', () => {
    it('parses a valid log line', () => {
      expect(
        appService.parseLogLine(
          '[2024-01-01][10:00:00][target][INFO] Test message'
        )
      ).toEqual({
        timestamp: '2024-01-01T10:00:00Z',
        level: 'info',
        target: 'target',
        message: 'Test message',
      })
    })

    it('preserves an invalid log line as an info entry', () => {
      const result = appService.parseLogLine('Invalid log line')

      expect(result).toEqual(
        expect.objectContaining({
          level: 'info',
          target: 'info',
          message: 'Invalid log line',
        })
      )
      expect(typeof result.timestamp).toBe('number')
    })
  })

  it('reads and parses logs through real invoke', async () => {
    ipcHandler.mockReturnValue(
      '[2024-01-01][10:00:00Z][target][INFO] Test message\n' +
        '[2024-01-01][10:01:00Z][target][ERROR] Error message'
    )

    const result = await appService.readLogs()

    expect(ipcHandler).toHaveBeenCalledWith('read_logs', {})
    expect(result.map((entry) => entry.message)).toEqual([
      'Test message',
      'Error message',
    ])
  })

  it('routes data-folder reads through APIs and TauriCoreService', async () => {
    ipcHandler.mockReturnValue({ data_folder: '/path/to/atomic/data' })

    await expect(appService.getJanDataFolder()).resolves.toBe(
      '/path/to/atomic/data'
    )
    expect(ipcHandler).toHaveBeenCalledWith('get_app_configurations', {})
  })

  it('routes data-folder relocation through APIs and TauriCoreService', async () => {
    ipcHandler.mockReturnValue(undefined)

    await appService.relocateJanDataFolder('/new/path/to/atomic/data')

    expect(ipcHandler).toHaveBeenCalledWith('change_app_data_folder', {
      newDataFolder: '/new/path/to/atomic/data',
    })
  })

  it('reads and updates the durable autostart preference', async () => {
    const configuration = {
      data_folder: '/path/to/atomic/data',
      quick_ask: false,
      autostart_preference: 'disabled' as const,
    }
    ipcHandler.mockImplementation((command: string) =>
      command === 'get_app_configurations' ? configuration : undefined
    )

    await expect(appService.getAutostartPreference()).resolves.toBe('disabled')
    await appService.setAutostartPreference('enabled')

    expect(ipcHandler).toHaveBeenCalledWith('update_app_configuration', {
      configuration: {
        ...configuration,
        autostart_preference: 'enabled',
      },
    })
  })

  it('performs factory reset through real invoke and preserves backend keys', async () => {
    window.localStorage.setItem('llama_cpp_backend_type', 'cpu')
    window.localStorage.setItem('discard-me', 'value')
    ipcHandler.mockReturnValue(undefined)

    await appService.factoryReset()

    expect(engineMocks.unload).toHaveBeenCalledTimes(2)
    expect(window.localStorage.getItem('llama_cpp_backend_type')).toBe('cpu')
    expect(window.localStorage.getItem('discard-me')).toBeNull()
    expect(ipcHandler).toHaveBeenCalledWith('factory_reset', {})
  })

  it('returns undefined when installer type invoke rejects', async () => {
    ipcHandler.mockRejectedValue(new Error('unavailable'))

    await expect(appService.getInstallerType()).resolves.toBeUndefined()
  })

  it('passes readYaml arguments through real invoke', async () => {
    ipcHandler.mockReturnValue({ enabled: true })

    await expect(appService.readYaml('/tmp/config.yml')).resolves.toEqual({
      enabled: true,
    })
    expect(ipcHandler).toHaveBeenCalledWith('read_yaml', {
      path: '/tmp/config.yml',
    })
  })

  describe('remote & LAN access', () => {
    const online = {
      state: 'online',
      url: 'https://quiet-river.trycloudflare.com',
      error: null,
      blockReason: null,
      canStart: false,
      canStop: true,
      serverHasApiKey: true,
    }

    it.each([
      ['getRemoteAccessStatus', 'GET', '/remote-access'],
      ['startRemoteAccess', 'POST', '/remote-access/start'],
      ['stopRemoteAccess', 'POST', '/remote-access/stop'],
    ] as const)('%s calls the core route %s %s and returns the status', async (method, verb, path) => {
      ipcHandler.mockReturnValue(online)

      await expect(appService[method]()).resolves.toEqual(online)
      expect(ipcHandler).toHaveBeenCalledWith('atomic_core_call', {
        method: verb,
        path,
        body: null,
      })
    })

    it('reads a snake_case status, so a serde rename cannot blank the page', async () => {
      ipcHandler.mockReturnValue({
        state: 'off',
        url: null,
        error: null,
        block_reason: 'server_stopped',
        can_start: false,
        can_stop: false,
        server_has_api_key: false,
      })

      await expect(appService.getRemoteAccessStatus()).resolves.toEqual({
        state: 'off',
        url: null,
        error: null,
        blockReason: 'server_stopped',
        canStart: false,
        canStop: false,
        serverHasApiKey: false,
      })
    })

    it('rejects with a code when the reply is not a status', async () => {
      ipcHandler.mockReturnValue({ running: true })

      await expect(appService.getRemoteAccessStatus()).rejects.toThrow(
        'malformed_status'
      )
    })

    it("rethrows the core's refusal as the bare reason the page parses", async () => {
      ipcHandler.mockRejectedValue({
        code: 'REMOTE_ACCESS_SERVER_STOPPED',
        message: 'Start the Local API Server first.',
        details: 'server_stopped',
      })

      await expect(appService.startRemoteAccess()).rejects.toBe(
        'server_stopped'
      )
    })

    it('passes any other failure through untouched', async () => {
      const unreachable = { code: 'CORE_UNREACHABLE', message: 'no core' }
      ipcHandler.mockRejectedValue(unreachable)

      await expect(appService.startRemoteAccess()).rejects.toBe(unreachable)
    })

    it('returns the LAN addresses in the order the core ranked them', async () => {
      ipcHandler.mockReturnValue({ addresses: ['192.168.1.20', '10.0.0.7'] })

      await expect(appService.getLanAddresses()).resolves.toEqual([
        '192.168.1.20',
        '10.0.0.7',
      ])
      expect(ipcHandler).toHaveBeenCalledWith('atomic_core_call', {
        method: 'GET',
        path: '/lan-addresses',
        body: null,
      })
    })

    it('treats a reply that is not a list of strings as no addresses', async () => {
      ipcHandler.mockReturnValue(null)
      await expect(appService.getLanAddresses()).resolves.toEqual([])

      ipcHandler.mockReturnValue({ addresses: ['192.168.1.20', 7, null] })
      await expect(appService.getLanAddresses()).resolves.toEqual([
        '192.168.1.20',
      ])
    })
  })
})
