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
  getLocalApiServerUrl,
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
