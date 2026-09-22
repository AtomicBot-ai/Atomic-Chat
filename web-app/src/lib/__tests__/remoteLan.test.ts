import { describe, expect, it } from 'vitest'

import {
  LAN_ACCESS_TONE,
  REMOTE_ACCESS_TONE,
  buildLanAccessUrls,
  buildRemoteApiUrl,
  isCoreFailure,
  isRemoteAccessActionAllowed,
  lanAccessMessage,
  lanAccessState,
  normalizeRemoteAccessStatus,
  parseRemoteAccessRejection,
  remoteAccessAction,
  remoteAccessMessage,
  toFailureCode,
} from '../remoteLan'
import type { RemoteAccessStatus } from '@/types/remoteAccess'

const status = (
  overrides: Partial<RemoteAccessStatus> = {}
): RemoteAccessStatus => ({
  state: 'off',
  url: null,
  error: null,
  blockReason: null,
  canStart: true,
  canStop: false,
  serverHasApiKey: true,
  ...overrides,
})

describe('normalizeRemoteAccessStatus', () => {
  it('reads the camelCase shape the core sends', () => {
    expect(
      normalizeRemoteAccessStatus({
        state: 'online',
        url: 'https://quiet-river.trycloudflare.com',
        error: null,
        blockReason: null,
        canStart: false,
        canStop: true,
        serverHasApiKey: true,
      })
    ).toEqual({
      state: 'online',
      url: 'https://quiet-river.trycloudflare.com',
      error: null,
      blockReason: null,
      canStart: false,
      canStop: true,
      serverHasApiKey: true,
    })
  })

  it('reads snake_case too, so a renamed field cannot blank the page', () => {
    expect(
      normalizeRemoteAccessStatus({
        state: 'off',
        url: null,
        error: null,
        block_reason: 'server_stopped',
        can_start: true,
        can_stop: false,
        server_has_api_key: true,
      })
    ).toEqual({
      state: 'off',
      url: null,
      error: null,
      blockReason: 'server_stopped',
      canStart: true,
      canStop: false,
      serverHasApiKey: true,
    })
  })

  it('defaults every missing flag to the cautious value', () => {
    expect(normalizeRemoteAccessStatus({ state: 'error' })).toEqual({
      state: 'error',
      url: null,
      error: null,
      blockReason: null,
      canStart: false,
      canStop: false,
      serverHasApiKey: false,
    })
  })

  it('keeps an error code it has never heard of', () => {
    expect(
      normalizeRemoteAccessStatus({ state: 'error', error: 'quota_exceeded' })
        ?.error
    ).toBe('quota_exceeded')
  })

  it('drops a block reason it has never heard of', () => {
    expect(
      normalizeRemoteAccessStatus({ state: 'off', blockReason: 'moon_phase' })
        ?.blockReason
    ).toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', 'online'],
    ['an array', ['online']],
    ['no state', { url: 'https://x.trycloudflare.com' }],
    ['an unknown state', { state: 'paused' }],
    ['a non-string state', { state: 1 }],
  ])('returns null for %s', (_label, raw) => {
    expect(normalizeRemoteAccessStatus(raw)).toBeNull()
  })
})

describe('state tones', () => {
  it('maps every tunnel state onto the shared status dot', () => {
    expect(REMOTE_ACCESS_TONE).toEqual({
      off: 'idle',
      starting: 'pending',
      online: 'ready',
      stopping: 'pending',
      error: 'error',
    })
  })

  it('maps every LAN state onto the shared status dot', () => {
    expect(LAN_ACCESS_TONE).toEqual({
      off: 'idle',
      starting: 'pending',
      online: 'ready',
    })
  })
})

describe('lanAccessState', () => {
  it.each([
    ['running', '0.0.0.0', 'online'],
    ['pending', '0.0.0.0', 'starting'],
    ['stopped', '0.0.0.0', 'off'],
    ['running', '127.0.0.1', 'off'],
    ['pending', '127.0.0.1', 'off'],
    ['stopped', '127.0.0.1', 'off'],
  ] as const)('server %s on %s is %s', (serverStatus, host, expected) => {
    expect(lanAccessState(serverStatus, host)).toBe(expected)
  })
})

describe('buildLanAccessUrls', () => {
  it('builds one URL per address, in the order the core gave them', () => {
    expect(buildLanAccessUrls(['192.168.1.20', '10.0.0.7'], 1337, '/v1')).toEqual(
      ['http://192.168.1.20:1337/v1', 'http://10.0.0.7:1337/v1']
    )
  })

  it.each([
    ['v1', 'http://192.168.1.20:1337/v1'],
    ['/v1/', 'http://192.168.1.20:1337/v1'],
    ['//api/v2//', 'http://192.168.1.20:1337/api/v2'],
    ['/', 'http://192.168.1.20:1337'],
    ['', 'http://192.168.1.20:1337'],
    ['  /v1  ', 'http://192.168.1.20:1337/v1'],
  ])('normalises the prefix %j', (prefix, expected) => {
    expect(buildLanAccessUrls(['192.168.1.20'], 1337, prefix)).toEqual([
      expected,
    ])
  })

  it('skips blanks and repeats', () => {
    expect(
      buildLanAccessUrls(['192.168.1.20', ' ', '192.168.1.20 '], 8080, '/v1')
    ).toEqual(['http://192.168.1.20:8080/v1'])
  })

  it('brackets an IPv6 address so the URL stays valid', () => {
    expect(buildLanAccessUrls(['fe80::1'], 1337, '/v1')).toEqual([
      'http://[fe80::1]:1337/v1',
    ])
  })

  it('is empty when there is nothing to show', () => {
    expect(buildLanAccessUrls([], 1337, '/v1')).toEqual([])
  })
})

describe('buildRemoteApiUrl', () => {
  it('appends the API prefix to the tunnel origin', () => {
    expect(buildRemoteApiUrl('https://quiet-river.trycloudflare.com', '/v1')).toBe(
      'https://quiet-river.trycloudflare.com/v1'
    )
  })

  it('keeps the origin only, whatever path the URL came with', () => {
    expect(
      buildRemoteApiUrl('https://quiet-river.trycloudflare.com/some/path/', 'v1/')
    ).toBe('https://quiet-river.trycloudflare.com/v1')
  })

  it('adds nothing for a bare slash prefix', () => {
    expect(buildRemoteApiUrl('https://quiet-river.trycloudflare.com/', '/')).toBe(
      'https://quiet-river.trycloudflare.com'
    )
  })

  it('still produces something usable from an unparseable URL', () => {
    expect(buildRemoteApiUrl('quiet-river.trycloudflare.com/', '/v1')).toBe(
      'quiet-river.trycloudflare.com/v1'
    )
  })

  it.each([[null], [undefined], [''], ['   ']])(
    'is null without a URL (%j)',
    (url) => {
      expect(buildRemoteApiUrl(url, '/v1')).toBeNull()
    }
  )
})

describe('remoteAccessAction', () => {
  it('offers Start before anything is known and while the tunnel is down', () => {
    expect(remoteAccessAction(null)).toBe('start')
    expect(remoteAccessAction(status({ state: 'off' }))).toBe('start')
    expect(
      remoteAccessAction(status({ state: 'error', error: 'exited' }))
    ).toBe('start')
  })

  it.each(['starting', 'online', 'stopping'] as const)(
    'offers Stop while %s',
    (state) => {
      expect(remoteAccessAction(status({ state }))).toBe('stop')
    }
  )

  it('keeps Stop on offer when a stop could not be confirmed', () => {
    expect(
      remoteAccessAction(
        status({
          state: 'error',
          error: 'stop_failed',
          canStart: false,
          canStop: true,
        })
      )
    ).toBe('stop')
  })
})

describe('isRemoteAccessActionAllowed', () => {
  it('allows nothing until a status has arrived', () => {
    expect(isRemoteAccessActionAllowed(null, 'start')).toBe(false)
    expect(isRemoteAccessActionAllowed(null, 'stop')).toBe(false)
  })

  it('follows canStart and canStop', () => {
    const online = status({ state: 'online', canStart: false, canStop: true })
    expect(isRemoteAccessActionAllowed(online, 'stop')).toBe(true)
    expect(isRemoteAccessActionAllowed(online, 'start')).toBe(false)
    expect(isRemoteAccessActionAllowed(status(), 'start')).toBe(true)
    expect(isRemoteAccessActionAllowed(status(), 'stop')).toBe(false)
  })

  it('does not let a stopped server grey Start out: the page starts it first', () => {
    expect(
      isRemoteAccessActionAllowed(
        status({ canStart: false, blockReason: 'server_stopped' }),
        'start'
      )
    ).toBe(true)
  })

  it('never depends on the API key', () => {
    expect(
      isRemoteAccessActionAllowed(status({ serverHasApiKey: false }), 'start')
    ).toBe(true)
  })
})

describe('toFailureCode', () => {
  it('keeps a machine code', () => {
    expect(toFailureCode('not_reachable')).toBe('not_reachable')
    expect(toFailureCode(' exited ')).toBe('exited')
  })

  it.each([
    [null],
    [undefined],
    [''],
    ['Failed to reach quiet-river.trycloudflare.com'],
    ['connect ECONNREFUSED 192.168.1.20:1337'],
    ['UPPER_CASE'],
    ['x'.repeat(80)],
  ])('collapses %j to unknown so no address reaches telemetry', (value) => {
    expect(toFailureCode(value)).toBe('unknown')
  })
})

describe('parseRemoteAccessRejection', () => {
  it('recognises the one blocking reason, bare as `coreCall` rethrows it', () => {
    expect(parseRemoteAccessRejection('server_stopped')).toEqual({
      kind: 'blocked',
      blockReason: 'server_stopped',
    })
  })

  it('reads a code from a bare string', () => {
    expect(parseRemoteAccessRejection('cloudflared_unavailable')).toEqual({
      kind: 'failed',
      code: 'cloudflared_unavailable',
    })
  })

  it('reads a code from an Error', () => {
    expect(parseRemoteAccessRejection(new Error('malformed_status'))).toEqual({
      kind: 'failed',
      code: 'malformed_status',
    })
    expect(parseRemoteAccessRejection(new Error('server_stopped'))).toEqual({
      kind: 'blocked',
      blockReason: 'server_stopped',
    })
  })

  it.each([
    [undefined],
    [null],
    [42],
    [{}],
    ['Command start_remote_access not found'],
    [new Error('dial tcp 10.0.0.7:7844: i/o timeout')],
  ])('falls back to unknown for %j', (error) => {
    expect(parseRemoteAccessRejection(error)).toEqual({
      kind: 'failed',
      code: 'unknown',
    })
  })

  it.each([
    [
      'CORE_UNREACHABLE',
      'The Atomic Chat core did not answer.',
      'core_unreachable',
    ],
    [
      'CORE_NOT_RUNNING',
      'The Atomic Chat core is stopping or has stopped.',
      'core_not_running',
    ],
    ['HTTP_502', 'Bad gateway from 10.0.0.7:1337', 'http_502'],
  ])(
    'reports a core failure by its code, %s, never by its message',
    (code, message, expected) => {
      const rejection = parseRemoteAccessRejection({
        code,
        message,
        details: 'connect ECONNREFUSED 127.0.0.1:39123',
      })

      expect(rejection).toEqual({ kind: 'failed', code: expected })
      expect(JSON.stringify(rejection)).not.toMatch(/Atomic Chat|10\.0|127\.0/)
    }
  )

  it('still collapses a core code that is not shaped like one', () => {
    expect(
      parseRemoteAccessRejection({
        code: 'quiet-river.trycloudflare.com',
        message: 'The Atomic Chat core did not answer.',
      })
    ).toEqual({ kind: 'failed', code: 'unknown' })
  })
})

describe('isCoreFailure', () => {
  it.each([
    [{ code: 'CORE_UNREACHABLE', message: 'The core did not answer.' }],
    [{ code: 'CORE_START_FAILED', message: 'It keeps stopping.', details: '' }],
    [{ code: 'HTTP_502', message: 'Bad gateway' }],
    // A core without the route refuses it like any other request.
    [
      {
        code: 'INVALID_ARGUMENT',
        message: 'No such control route: /atomic/v1/remote-access',
      },
    ],
  ])('recognises the relay failure %j', (error) => {
    expect(isCoreFailure(error)).toBe(true)
  })

  it.each([
    // A `REMOTE_ACCESS_*` refusal as `coreCall` rethrows it.
    ['server_stopped'],
    [new Error('malformed_status')],
    [{ message: 'no code' }],
    [{ code: 502, message: 'a numeric code' }],
    [null],
    [undefined],
  ])('does not take %j for one', (error) => {
    expect(isCoreFailure(error)).toBe(false)
  })
})

describe('remoteAccessMessage', () => {
  const quiet = {
    unavailable: false,
    rejection: null,
    status: status(),
    hasApiKey: true,
  }

  it('says nothing when there is nothing to say', () => {
    expect(remoteAccessMessage(quiet)).toBeNull()
    expect(remoteAccessMessage({ ...quiet, status: null })).toBeNull()
  })

  it('warns in amber when no key protects the API', () => {
    expect(remoteAccessMessage({ ...quiet, hasApiKey: false })).toEqual({
      key: 'settings:remoteLan.noKeyWarning',
      tone: 'warning',
    })
  })

  it('explains a stopped server quietly, ahead of the key warning', () => {
    expect(
      remoteAccessMessage({
        ...quiet,
        hasApiKey: false,
        status: status({ blockReason: 'server_stopped', canStart: false }),
      })
    ).toEqual({
      key: 'settings:remoteLan.remote.block.serverStopped',
      tone: 'muted',
    })
  })

  it.each([
    'cloudflared_unavailable',
    'no_url',
    'not_registered',
    'not_reachable',
    'exited',
    'stop_failed',
  ])('has its own red line for %s, ahead of the block reason', (code) => {
    expect(
      remoteAccessMessage({
        ...quiet,
        hasApiKey: false,
        status: status({
          state: 'error',
          error: code,
          blockReason: 'server_stopped',
        }),
      })
    ).toEqual({
      key: `settings:remoteLan.remote.error.${code}`,
      tone: 'destructive',
    })
  })

  it('falls back to the generic line, with the code, for one it does not know', () => {
    expect(
      remoteAccessMessage({
        ...quiet,
        status: status({ state: 'error', error: 'quota_exceeded' }),
      })
    ).toEqual({
      key: 'settings:remoteLan.remote.error.unknown',
      tone: 'destructive',
      params: { code: 'quota_exceeded' },
    })
  })

  it('still reports an error state that came without a code', () => {
    expect(
      remoteAccessMessage({ ...quiet, status: status({ state: 'error' }) })
    ).toEqual({
      key: 'settings:remoteLan.remote.error.unknown',
      tone: 'destructive',
      params: { code: 'unknown' },
    })
  })

  it('puts what the last click ran into ahead of what the tunnel reports', () => {
    expect(
      remoteAccessMessage({
        ...quiet,
        rejection: { kind: 'failed', code: 'cloudflared_unavailable' },
        status: status({ state: 'error', error: 'exited' }),
      })
    ).toEqual({
      key: 'settings:remoteLan.remote.error.cloudflared_unavailable',
      tone: 'destructive',
    })
    expect(
      remoteAccessMessage({
        ...quiet,
        rejection: { kind: 'blocked', blockReason: 'server_stopped' },
      })
    ).toEqual({
      key: 'settings:remoteLan.remote.block.serverStopped',
      tone: 'muted',
    })
  })

  it('puts a backend without the feature ahead of everything', () => {
    expect(
      remoteAccessMessage({
        unavailable: true,
        rejection: { kind: 'failed', code: 'exited' },
        status: status({ state: 'error', error: 'exited' }),
        hasApiKey: false,
      })
    ).toEqual({ key: 'settings:remoteLan.remote.unavailable', tone: 'muted' })
  })
})

describe('lanAccessMessage', () => {
  const online = {
    state: 'online' as const,
    serverStatus: 'running' as const,
    serverHost: '0.0.0.0',
    addresses: ['192.168.1.20'],
    hasApiKey: true,
  }

  it('says nothing while LAN access is up, keyed and reachable', () => {
    expect(lanAccessMessage(online)).toBeNull()
  })

  it('reports a machine with no address to share, ahead of the key warning', () => {
    expect(
      lanAccessMessage({ ...online, addresses: [], hasApiKey: false })
    ).toEqual({
      key: 'settings:remoteLan.lan.block.noAddresses',
      tone: 'warning',
    })
  })

  it('does not call the list empty before the first lookup is back', () => {
    expect(lanAccessMessage({ ...online, addresses: null })).toBeNull()
  })

  it('warns in amber when LAN access is up without a key', () => {
    expect(lanAccessMessage({ ...online, hasApiKey: false })).toEqual({
      key: 'settings:remoteLan.lan.noKeyWarning',
      tone: 'warning',
    })
  })

  it('explains a stopped server', () => {
    expect(
      lanAccessMessage({
        ...online,
        state: 'off',
        serverStatus: 'stopped',
        hasApiKey: false,
      })
    ).toEqual({
      key: 'settings:remoteLan.lan.block.serverStopped',
      tone: 'muted',
    })
  })

  it('explains a server that only listens on loopback', () => {
    expect(
      lanAccessMessage({
        ...online,
        state: 'off',
        serverHost: '127.0.0.1',
        hasApiKey: false,
      })
    ).toEqual({
      key: 'settings:remoteLan.lan.block.loopbackOnly',
      tone: 'muted',
    })
  })

  it('keeps the key warning to itself while nothing is exposed', () => {
    expect(
      lanAccessMessage({
        ...online,
        state: 'off',
        serverStatus: 'pending',
        serverHost: '127.0.0.1',
        hasApiKey: false,
      })
    ).toBeNull()
  })
})
