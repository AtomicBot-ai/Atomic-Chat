import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('reads the merged logs through read_unified_logs', async () => {
    const entry = {
      timestamp: '2026-09-28T12:00:05Z',
      source: 'core',
      target: 'engine:llamacpp/qwen3-8b',
      level: 'INFO',
      message: '[stderr] loaded',
    }
    ipcHandler.mockReturnValue([entry])

    await expect(appService.readUnifiedLogs()).resolves.toEqual([entry])
    expect(ipcHandler).toHaveBeenCalledWith('read_unified_logs', {})
  })

  describe('exportLogs', () => {
    const originalTz = process.env.TZ

    afterEach(() => {
      process.env.TZ = originalTz
      vi.useRealTimers()
    })

    it('does not export when the save dialog is cancelled', async () => {
      ipcHandler.mockImplementation((command: string) =>
        command === 'save_dialog' ? null : undefined
      )

      await expect(appService.exportLogs()).resolves.toBeNull()
      expect(ipcHandler).not.toHaveBeenCalledWith(
        'export_logs',
        expect.anything()
      )
    })

    it('exports to the chosen path and returns what was written', async () => {
      ipcHandler.mockImplementation((command: string) => {
        if (command === 'save_dialog') return '/tmp/logs.log'
        if (command === 'export_logs') return { path: '/tmp/logs.log', bytes: 42 }
      })

      await expect(appService.exportLogs()).resolves.toEqual({
        path: '/tmp/logs.log',
        bytes: 42,
      })
      expect(ipcHandler).toHaveBeenCalledWith('export_logs', {
        path: '/tmp/logs.log',
      })
    })

    it.each(['UTC', 'Europe/Moscow', 'America/Los_Angeles'])(
      'names the file in UTC when the zone is %s',
      async (zone) => {
        process.env.TZ = zone
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-09-28T23:30:05Z'))
        ipcHandler.mockReturnValue(null)

        await appService.exportLogs()

        expect(ipcHandler).toHaveBeenCalledWith('save_dialog', {
          options: {
            defaultPath: 'atomic-chat-logs-2026-09-28_23-30-05.log',
            filters: [{ name: 'Log', extensions: ['log'] }],
          },
        })
      }
    )

    it('passes a failed write on to the caller', async () => {
      ipcHandler.mockImplementation((command: string) => {
        if (command === 'save_dialog') return '/read-only/logs.log'
        throw 'could not write /read-only/logs.log: Permission denied'
      })

      await expect(appService.exportLogs()).rejects.toBe(
        'could not write /read-only/logs.log: Permission denied'
      )
    })
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

  it('performs factory reset through real invoke and preserves backend keys and the onboarding cohort', async () => {
    const cohort = '{"experiment":"onboarding_v1","variant":"none","assignedAt":1}'
    window.localStorage.setItem('llama_cpp_backend_type', 'cpu')
    window.localStorage.setItem('atomic-onboarding-cohort', cohort)
    window.localStorage.setItem('discard-me', 'value')
    ipcHandler.mockReturnValue(undefined)

    await appService.factoryReset()

    expect(engineMocks.unload).toHaveBeenCalledTimes(2)
    expect(window.localStorage.getItem('llama_cpp_backend_type')).toBe('cpu')
    // A reset install stays in its experiment cohort, as it stays one person.
    expect(window.localStorage.getItem('atomic-onboarding-cohort')).toBe(cohort)
    expect(window.localStorage.getItem('discard-me')).toBeNull()
    expect(ipcHandler).toHaveBeenCalledWith('factory_reset', {})
  })

  it('returns undefined when installer type invoke rejects', async () => {
    ipcHandler.mockRejectedValue(new Error('unavailable'))

    await expect(appService.getInstallerType()).resolves.toBeUndefined()
  })

  describe('getCoreVersion', () => {
    it('reports the attached core version over the pin', async () => {
      ipcHandler.mockReturnValue({
        running: true,
        expected_version: '0.7.1',
        attached: { version: '0.7.2', pid: 42 },
      })

      await expect(appService.getCoreVersion()).resolves.toBe('0.7.2')
      expect(ipcHandler).toHaveBeenCalledWith('atomic_core_status', {})
    })

    it('falls back to the pin while the core is not attached yet', async () => {
      ipcHandler.mockReturnValue({
        running: false,
        expected_version: '0.7.1',
        attached: null,
      })

      await expect(appService.getCoreVersion()).resolves.toBe('0.7.1')
    })

    it('is undefined with neither an attached core nor a pin', async () => {
      ipcHandler.mockReturnValue({
        running: false,
        expected_version: null,
        attached: null,
      })

      await expect(appService.getCoreVersion()).resolves.toBeUndefined()
    })

    it('is undefined where the status command does not exist', async () => {
      ipcHandler.mockRejectedValue(new Error('command not found'))

      await expect(appService.getCoreVersion()).resolves.toBeUndefined()
    })
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
