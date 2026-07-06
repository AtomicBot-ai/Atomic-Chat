import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  isLocalProvider,
  isLoopbackUrl,
  isKeylessRemoteProvider,
  registerRemoteProvider,
  unregisterRemoteProvider,
} from '../registerRemoteProvider'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function makeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    provider: 'openai',
    active: true,
    api_key: 'sk-test',
    base_url: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5.4' }],
    custom_header: [],
    ...overrides,
  } as unknown as ModelProvider
}

describe('isLocalProvider', () => {
  it.each(['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'])(
    'treats %s as local',
    (name) => {
      expect(isLocalProvider(name)).toBe(true)
    }
  )

  it('treats a remote provider as non-local', () => {
    expect(isLocalProvider('openai')).toBe(false)
  })

  it('handles null/undefined/empty safely', () => {
    expect(isLocalProvider(null)).toBe(false)
    expect(isLocalProvider(undefined)).toBe(false)
    expect(isLocalProvider('')).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it.each([
    'http://localhost:1337/v1',
    'http://127.0.0.1:1337/v1',
    'http://0.0.0.0:11434',
  ])('detects loopback host in %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true)
  })

  it('does not match the bracketed IPv6 loopback form (known limitation)', () => {
    // `URL.hostname` for an IPv6 host keeps the brackets (`[::1]`), which
    // never equals the bare `'::1'` this helper compares against.
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(false)
  })

  it('returns false for a non-loopback host', () => {
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('returns false for falsy input', () => {
    expect(isLoopbackUrl(undefined)).toBe(false)
    expect(isLoopbackUrl(null)).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })

  it('returns false for a malformed URL instead of throwing', () => {
    expect(isLoopbackUrl('not-a-url')).toBe(false)
  })
})

describe('isKeylessRemoteProvider', () => {
  it('is true for a remote provider pointed at a loopback base_url', () => {
    expect(
      isKeylessRemoteProvider({ provider: 'ollama', base_url: 'http://localhost:11434' })
    ).toBe(true)
  })

  it('is false for a local engine even when pointed at loopback', () => {
    expect(
      isKeylessRemoteProvider({ provider: 'llamacpp-upstream', base_url: 'http://localhost:1337' })
    ).toBe(false)
  })

  it('is false for a remote provider with a public base_url', () => {
    expect(
      isKeylessRemoteProvider({ provider: 'openai', base_url: 'https://api.openai.com' })
    ).toBe(false)
  })

  it('is false for null/undefined', () => {
    expect(isKeylessRemoteProvider(null)).toBe(false)
    expect(isKeylessRemoteProvider(undefined)).toBe(false)
  })
})

describe('registerRemoteProvider', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('skips local providers without calling invoke', async () => {
    const result = await registerRemoteProvider(
      makeProvider({ provider: 'llamacpp-upstream' })
    )
    expect(result).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('skips a remote provider with no API key and no loopback base_url', async () => {
    const result = await registerRemoteProvider(
      makeProvider({ api_key: '', base_url: 'https://api.openai.com/v1' })
    )
    expect(result).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('registers a keyless remote provider pointed at loopback', async () => {
    const result = await registerRemoteProvider(
      makeProvider({ provider: 'ollama', api_key: '', base_url: 'http://localhost:11434' })
    )
    expect(result).toBe(true)
    expect(invoke).toHaveBeenCalledWith('register_provider_config', {
      request: expect.objectContaining({ provider: 'ollama', api_key: undefined }),
    })
  })

  it('registers a remote provider with an API key, mapping models/headers', async () => {
    const provider = makeProvider({
      custom_header: [{ header: 'X-Test', value: '1' }],
      models: [{ id: 'a' }, { id: 'b' }],
    })

    const result = await registerRemoteProvider(provider)

    expect(result).toBe(true)
    expect(invoke).toHaveBeenCalledWith('register_provider_config', {
      request: {
        provider: 'openai',
        api_key: 'sk-test',
        base_url: 'https://api.openai.com/v1',
        custom_headers: [{ header: 'X-Test', value: '1' }],
        models: ['a', 'b'],
      },
    })
  })

  it('trims the base_url before sending', async () => {
    await registerRemoteProvider(makeProvider({ base_url: '  https://api.openai.com/v1  ' }))
    expect(invoke).toHaveBeenCalledWith(
      'register_provider_config',
      expect.objectContaining({
        request: expect.objectContaining({ base_url: 'https://api.openai.com/v1' }),
      })
    )
  })
})

describe('unregisterRemoteProvider', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('skips local providers without calling invoke', async () => {
    await unregisterRemoteProvider('mlx')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('calls invoke for a remote provider', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await unregisterRemoteProvider('openai')
    expect(invoke).toHaveBeenCalledWith('unregister_provider_config', {
      provider: 'openai',
    })
  })

  it('swallows backend errors instead of throwing', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('not registered'))
    await expect(unregisterRemoteProvider('openai')).resolves.toBeUndefined()
  })
})
