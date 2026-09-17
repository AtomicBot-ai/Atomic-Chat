import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useLocalApiServer } from '../useLocalApiServer'

/**
 * The persisted settings as the store finds them on launch. The sibling
 * `useLocalApiServer.test.ts` stubs out `persist`, so the migration — and
 * everything else that depends on what is actually saved — is exercised here
 * against the real middleware and localStorage.
 */
const persisted = (state: Record<string, unknown>, version: number) =>
  localStorage.setItem(
    localStorageKey.settingLocalApiServer,
    JSON.stringify({ state, version })
  )

const saved = () =>
  JSON.parse(
    localStorage.getItem(localStorageKey.settingLocalApiServer) ?? '{}'
  ) as { state: Record<string, unknown>; version: number }

describe('useLocalApiServer — persisted state migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts a v3 install with remote access on manual and unconfirmed', async () => {
    persisted(
      {
        enableOnStartup: true,
        serverHost: '0.0.0.0',
        serverPort: 4000,
        apiPrefix: '/v1',
        apiKey: 'sk-existing',
        trustedHosts: ['192.168.1.20'],
      },
      3
    )

    await useLocalApiServer.persist.rehydrate()

    const state = useLocalApiServer.getState()
    expect(state.remoteAccessAutoStart).toBe(false)
    expect(state.exposeWithoutKeyAcknowledged).toBe(false)
    // A server already bound on every interface is what the new page reports
    // as LAN access; the migration must not take it off the network.
    expect(state.serverHost).toBe('0.0.0.0')
    expect(state.serverPort).toBe(4000)
    expect(state.apiKey).toBe('sk-existing')
    expect(state.trustedHosts).toEqual(['192.168.1.20'])
    expect(state.enableOnStartup).toBe(true)
  })

  it('does not trust new-field values smuggled into an older blob', async () => {
    persisted(
      { remoteAccessAutoStart: true, exposeWithoutKeyAcknowledged: true },
      3
    )

    await useLocalApiServer.persist.rehydrate()

    expect(useLocalApiServer.getState().remoteAccessAutoStart).toBe(false)
    expect(useLocalApiServer.getState().exposeWithoutKeyAcknowledged).toBe(
      false
    )
  })

  it('still runs the older steps for an install that skipped versions', async () => {
    persisted({ enableOnStartup: false, serverHost: '127.0.0.1' }, 0)

    await useLocalApiServer.persist.rehydrate()

    const state = useLocalApiServer.getState()
    expect(state.lastServerModels).toEqual([])
    expect(state.defaultModelLocalApiServer).toBeNull()
    expect(state.enableOnStartup).toBe(true)
    expect(state.remoteAccessAutoStart).toBe(false)
  })

  it('keeps what a v4 install chose', async () => {
    persisted(
      {
        remoteAccessAutoStart: true,
        exposeWithoutKeyAcknowledged: true,
        serverHost: '0.0.0.0',
        apiKey: '',
      },
      4
    )

    await useLocalApiServer.persist.rehydrate()

    const state = useLocalApiServer.getState()
    expect(state.remoteAccessAutoStart).toBe(true)
    expect(state.exposeWithoutKeyAcknowledged).toBe(true)
    expect(state.serverHost).toBe('0.0.0.0')
  })

  it('saves the new switches, and never a tunnel URL', async () => {
    await useLocalApiServer.persist.rehydrate()

    useLocalApiServer.getState().setRemoteAccessAutoStart(true)
    useLocalApiServer.getState().setExposeWithoutKeyAcknowledged(true)

    expect(saved().version).toBe(4)
    expect(saved().state.remoteAccessAutoStart).toBe(true)
    expect(saved().state.exposeWithoutKeyAcknowledged).toBe(true)
    expect(JSON.stringify(saved())).not.toContain('trycloudflare')
  })
})

describe('useLocalApiServer — API key and the no-key confirmation', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useLocalApiServer.persist.rehydrate()
    useLocalApiServer.setState({
      apiKey: '',
      exposeWithoutKeyAcknowledged: false,
    })
  })

  it('withdraws the confirmation as soon as a key is saved', () => {
    useLocalApiServer.getState().setExposeWithoutKeyAcknowledged(true)

    useLocalApiServer.getState().setApiKey('sk-atomic-abc')

    expect(useLocalApiServer.getState().apiKey).toBe('sk-atomic-abc')
    expect(useLocalApiServer.getState().exposeWithoutKeyAcknowledged).toBe(
      false
    )
  })

  it('so losing that key later asks again', () => {
    useLocalApiServer.getState().setExposeWithoutKeyAcknowledged(true)
    useLocalApiServer.getState().setApiKey('sk-atomic-abc')

    useLocalApiServer.getState().setApiKey('')

    expect(useLocalApiServer.getState().apiKey).toBe('')
    expect(useLocalApiServer.getState().exposeWithoutKeyAcknowledged).toBe(
      false
    )
  })

  it.each([[''], ['   ']])(
    'keeps the confirmation while the key stays blank (%j)',
    (blank) => {
      useLocalApiServer.getState().setExposeWithoutKeyAcknowledged(true)

      useLocalApiServer.getState().setApiKey(blank)

      expect(useLocalApiServer.getState().apiKey).toBe(blank)
      expect(useLocalApiServer.getState().exposeWithoutKeyAcknowledged).toBe(
        true
      )
    }
  )
})
