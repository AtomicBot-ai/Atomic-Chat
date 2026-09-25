import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appState, localApiState, startServer, stopServer } = vi.hoisted(() => ({
  appState: {
    serverStatus: 'stopped' as 'running' | 'stopped' | 'pending',
    setServerStatus: vi.fn(),
  },
  localApiState: {
    serverHost: '127.0.0.1',
    serverPort: 1337,
    apiPrefix: '/v1',
    apiKey: 'secret',
    trustedHosts: ['example.test'],
    corsEnabled: true,
    verboseLogs: true,
    proxyTimeout: 600,
    enableOnStartup: true,
    setServerPort: vi.fn(),
  },
  startServer: vi.fn(),
  stopServer: vi.fn(),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: { getState: () => appState },
}))
vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: { getState: () => localApiState },
}))

import {
  makeLoadedStatus,
  makeStatus,
} from '@/lib/diffusion/__tests__/image-fixtures'
import type { DiffusionStatus } from '@/services/diffusion/types'

import {
  getLocalApiServerUrl,
  hasResidentMediaModel,
  raiseLocalApiServerForMediaModel,
  setLocalApiServerRunning,
  startLocalApiServer,
  stopLocalApiServer,
} from '../localApiServerControl'

describe('localApiServerControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localApiState.serverHost = '127.0.0.1'
    localApiState.serverPort = 1337
    localApiState.apiPrefix = '/v1'
    localApiState.enableOnStartup = true
    appState.serverStatus = 'stopped'
    startServer.mockResolvedValue(1337)
    stopServer.mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).core = { api: { startServer, stopServer } }
  })

  it('sends exactly the keys the Rust config accepts', async () => {
    await startLocalApiServer()
    expect(startServer).toHaveBeenCalledTimes(1)
    const payload = startServer.mock.calls[0][0]
    expect(payload).toEqual({
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      apiKey: 'secret',
      trustedHosts: ['example.test'],
      proxyTimeout: 600,
    })
    // The dead cors/verbose flags must not reappear: the IPC shim drops them
    // and `StartServerConfig` has no such fields.
    expect(payload).not.toHaveProperty('isCorsEnabled')
    expect(payload).not.toHaveProperty('isVerboseEnabled')
  })

  it('persists the port the proxy actually bound to', async () => {
    localApiState.serverPort = 0
    startServer.mockResolvedValue(49_152)
    await startLocalApiServer()
    expect(localApiState.setServerPort).toHaveBeenCalledWith(49_152)
  })

  it('leaves the port alone when the requested one was used', async () => {
    await startLocalApiServer()
    expect(localApiState.setServerPort).not.toHaveBeenCalled()
  })

  it('is a no-op when the native bridge is absent (web build)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).core = undefined
    await expect(startLocalApiServer()).resolves.toBeUndefined()
    await expect(stopLocalApiServer()).resolves.toBeUndefined()
  })

  it('drives serverStatus pending -> running on a successful start', async () => {
    await setLocalApiServerRunning(true)
    expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
      'pending',
      'running',
    ])
  })

  it('drives serverStatus pending -> stopped on a successful stop', async () => {
    await setLocalApiServerRunning(false)
    expect(stopServer).toHaveBeenCalledTimes(1)
    expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
      'pending',
      'stopped',
    ])
  })

  it('resets to stopped and rethrows when the start fails', async () => {
    startServer.mockRejectedValue(new Error('Address already in use'))
    await expect(setLocalApiServerRunning(true)).rejects.toThrow(
      'Address already in use'
    )
    expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
      'pending',
      'stopped',
    ])
  })

  it('resets to stopped when the stop fails, rather than staying pending', async () => {
    stopServer.mockRejectedValue(new Error('teardown blew up'))
    await expect(setLocalApiServerRunning(false)).rejects.toThrow('teardown blew up')
    expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
      'pending',
      'stopped',
    ])
  })

  describe('hasResidentMediaModel', () => {
    const diffusionWith = (status: DiffusionStatus, supported = true) => ({
      isSupported: () => supported,
      getStatus: vi.fn(async () => status),
    })

    it.each([
      ['a loaded image model', true, makeLoadedStatus()],
      [
        'a model still loading',
        true,
        makeStatus({ model: { state: 'loading', loaded: null } }),
      ],
      ['nothing loaded', false, makeStatus()],
      [
        'a host the plugin refuses',
        false,
        { ...makeLoadedStatus(), configured: false },
      ],
    ])('reads %s as resident: %s', async (_label, expected, status) => {
      await expect(hasResidentMediaModel(diffusionWith(status))).resolves.toBe(
        expected
      )
    })

    it('never asks a build without image generation', async () => {
      const diffusion = diffusionWith(makeLoadedStatus(), false)
      await expect(hasResidentMediaModel(diffusion)).resolves.toBe(false)
      expect(diffusion.getStatus).not.toHaveBeenCalled()
    })

    it('reads a status it cannot get as nothing resident', async () => {
      const diffusion = {
        isSupported: () => true,
        getStatus: vi.fn(async () => {
          throw new Error('core is gone')
        }),
      }
      await expect(hasResidentMediaModel(diffusion)).resolves.toBe(false)
    })
  })

  describe('raiseLocalApiServerForMediaModel', () => {
    it('starts a stopped server when auto-start is on', async () => {
      await raiseLocalApiServerForMediaModel()
      expect(startServer).toHaveBeenCalledTimes(1)
      expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
        'pending',
        'running',
      ])
    })

    it('leaves the server down when auto-start is off', async () => {
      localApiState.enableOnStartup = false
      await raiseLocalApiServerForMediaModel()
      expect(startServer).not.toHaveBeenCalled()
      expect(appState.setServerStatus).not.toHaveBeenCalled()
    })

    it.each(['running', 'pending'] as const)(
      'leaves a %s server alone',
      async (status) => {
        appState.serverStatus = status
        await raiseLocalApiServerForMediaModel()
        expect(startServer).not.toHaveBeenCalled()
      }
    )

    it('swallows a failed start, leaving the status stopped', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      startServer.mockRejectedValue(new Error('Address already in use'))
      await expect(raiseLocalApiServerForMediaModel()).resolves.toBeUndefined()
      expect(appState.setServerStatus.mock.calls.map((c) => c[0])).toEqual([
        'pending',
        'stopped',
      ])
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('getLocalApiServerUrl', () => {
    it('builds the dial address from the persisted config', () => {
      expect(getLocalApiServerUrl()).toBe('http://127.0.0.1:1337/v1')
    })

    it('rewrites the listen-any host to loopback', () => {
      localApiState.serverHost = '0.0.0.0'
      expect(getLocalApiServerUrl()).toBe('http://127.0.0.1:1337/v1')
    })

    it('normalises a prefix without a leading slash', () => {
      localApiState.apiPrefix = 'v1'
      expect(getLocalApiServerUrl()).toBe('http://127.0.0.1:1337/v1')
    })
  })
})
