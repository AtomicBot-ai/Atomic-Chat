import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  checkProviderKey,
  classifyKeyCheck,
  keyCheckUrl,
  noteProviderRequestError,
  noteProviderRequestSucceeded,
  recordKeyCheck,
} from '@/lib/provider-key-check'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'

const openai = (patch: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    provider: 'openai',
    active: true,
    models: [],
    settings: [],
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    ...patch,
  }) as ModelProvider

const failed = (
  httpStatus: number | undefined,
  message: string,
  responseBody?: string
) => ({
  ok: false,
  latencyMs: 10,
  modelCount: 0,
  message,
  ...(httpStatus ? { httpStatus } : {}),
  ...(responseBody !== undefined ? { responseBody } : {}),
})

/** What the AI SDK throws for a non-2xx answer (`APICallError`'s fields). */
const apiCallError = (statusCode: number, responseBody: string) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, responseBody })

const OPENAI_INVALID_KEY = JSON.stringify({
  error: {
    message: 'Incorrect API key provided: invalid-*******-key.',
    type: 'invalid_request_error',
    code: 'invalid_api_key',
  },
})
const OPENAI_MISSING_SCOPE = JSON.stringify({
  error: {
    message:
      'You have insufficient permissions for this operation. Missing scopes: api.model.read.',
    type: 'invalid_request_error',
  },
})

const statuses = () => useProviderKeyStatusStore.getState().statuses
const statusOf = (key: string) =>
  keyStatusFor(openai({ api_key: key }), statuses())

describe('classifyKeyCheck', () => {
  it('calls a key that listed the models verified', () => {
    expect(
      classifyKeyCheck({ ok: true, latencyMs: 5, modelCount: 12 })
    ).toEqual({ kind: 'verified' })
  })

  it.each([
    [
      'a 401 for an invalid key',
      failed(
        401,
        'Authentication failed: an API key is required or invalid for OpenAI.',
        OPENAI_INVALID_KEY
      ),
    ],
    // Gemini's OpenAI-compatible endpoint answers a bad key with 400.
    [
      "Gemini's invalid-key 400",
      failed(
        400,
        'Cannot fetch models from Gemini: HTTP 400: …',
        '[{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]'
      ),
    ],
    [
      'an invalid-key envelope served with 200',
      failed(undefined, 'Gateway returned an error: Invalid API key'),
    ],
  ])('refuses %s', (_, result) => {
    expect(classifyKeyCheck(result)).toMatchObject({
      kind: 'refused',
      reason: 'key',
      message: result.message,
    })
  })

  it('saves a restricted key the model list is closed to, in its own words', () => {
    expect(
      classifyKeyCheck(
        failed(
          401,
          'Authentication failed: an API key is required or invalid for OpenAI.',
          OPENAI_MISSING_SCOPE
        )
      )
    ).toEqual({
      kind: 'unverified',
      message:
        'HTTP 401: You have insufficient permissions for this operation. Missing scopes: api.model.read.',
    })
  })

  it('saves a key a gateway answers 403, unverified', () => {
    expect(
      classifyKeyCheck(
        failed(
          403,
          'Access forbidden: check your API key permissions for Gateway.',
          '{"error":{"message":"Route /models is not enabled for this key"}}'
        )
      )
    ).toEqual({
      kind: 'unverified',
      message: 'HTTP 403: Route /models is not enabled for this key',
    })
  })

  it("does not take the Local API Server's own 401 for the provider's", () => {
    expect(
      classifyKeyCheck(
        failed(
          401,
          'Authentication failed',
          'Invalid or missing authorization token'
        )
      ).kind
    ).toBe('unverified')
  })

  it.each([
    [undefined, 'Cannot connect to OpenAI at https://api.openai.com/v1.'],
    [404, 'Models endpoint not found for OpenAI.'],
    [500, 'Cannot fetch models from OpenAI: HTTP 500: upstream'],
    [400, 'Cannot fetch models from OpenAI: HTTP 400: bad request'],
  ])('cannot tell from a %s failure', (status, message) => {
    expect(classifyKeyCheck(failed(status, message))).toEqual({
      kind: 'unverified',
      message,
    })
  })
})

describe('checkProviderKey', () => {
  beforeEach(() => {
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
    })
  })

  it('asks with the key being saved, not the one stored', async () => {
    const checkProviderEndpoint = vi
      .fn()
      .mockResolvedValue(
        failed(401, 'Authentication failed', OPENAI_INVALID_KEY)
      )
    const hub = { providers: () => ({ checkProviderEndpoint }) } as never

    const outcome = await checkProviderKey(
      openai({ api_key: 'sk-old' }),
      'invalid-qa-test-key',
      hub
    )

    expect(outcome.kind).toBe('refused')
    expect(checkProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: 'invalid-qa-test-key' })
    )
  })

  it("refuses the app's own Local API Server without asking it", async () => {
    const checkProviderEndpoint = vi.fn()
    const hub = { providers: () => ({ checkProviderEndpoint }) } as never

    const outcome = await checkProviderKey(
      openai({ base_url: 'http://127.0.0.1:1337/v1' }),
      'sk-x',
      hub
    )

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'ownServer',
      serverUrl: 'http://127.0.0.1:1337/v1',
    })
    expect(checkProviderEndpoint).not.toHaveBeenCalled()
  })

  it('treats a check that cannot run as unverified', async () => {
    const hub = {
      providers: () => ({
        checkProviderEndpoint: vi.fn().mockRejectedValue(new Error('IPC gone')),
      }),
    } as never

    expect(await checkProviderKey(openai(), 'sk-x', hub)).toEqual({
      kind: 'unverified',
      message: 'IPC gone',
    })
  })
})

describe('keyCheckUrl', () => {
  const openrouter = (patch: Partial<ModelProvider> = {}) =>
    openai({
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      key_check: { path: '/key' },
      ...patch,
    })
  const huggingface = (patch: Partial<ModelProvider> = {}) =>
    openai({
      provider: 'huggingface',
      base_url: 'https://router.huggingface.co/v1',
      key_check: { url: 'https://huggingface.co/api/whoami-v2' },
      ...patch,
    })

  it('joins a path onto the base URL', () => {
    expect(keyCheckUrl(openrouter())).toBe('https://openrouter.ai/api/v1/key')
    expect(
      keyCheckUrl(openrouter({ base_url: ' https://openrouter.ai/api/v1/ ' }))
    ).toBe('https://openrouter.ai/api/v1/key')
  })

  it('uses an absolute URL on the base URL’s parent domain', () => {
    expect(keyCheckUrl(huggingface())).toBe(
      'https://huggingface.co/api/whoami-v2'
    )
  })

  it('never sends the key to the provider once the base URL is another server', () => {
    expect(
      keyCheckUrl(huggingface({ base_url: 'https://my-gateway.example/v1' }))
    ).toBeUndefined()
  })

  it.each([
    ['no key_check', openai()],
    [
      'a plain-HTTP url',
      huggingface({
        key_check: { url: 'http://huggingface.co/api/whoami-v2' },
      }),
    ],
    [
      'a method it does not speak',
      openrouter({ key_check: { path: '/key', method: 'POST' as 'GET' } }),
    ],
    ['a path that is not one', openrouter({ key_check: { path: 'key' } })],
    ['no base URL', openrouter({ base_url: '' })],
  ])('has none for %s', (_, provider) => {
    expect(keyCheckUrl(provider)).toBeUndefined()
  })
})

describe('checkProviderKey with a registry key_check', () => {
  const hubWith = () => {
    const checkProviderKeyUrl = vi.fn()
    const checkProviderEndpoint = vi.fn()
    return {
      checkProviderKeyUrl,
      checkProviderEndpoint,
      hub: {
        providers: () => ({ checkProviderKeyUrl, checkProviderEndpoint }),
      } as never,
    }
  }
  const openrouter = (patch: Partial<ModelProvider> = {}) =>
    openai({
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      key_check: { path: '/key' },
      ...patch,
    })

  it('asks the key-check endpoint, not the public model list, and takes any 2xx', async () => {
    const { hub, checkProviderKeyUrl, checkProviderEndpoint } = hubWith()
    checkProviderKeyUrl.mockResolvedValue({
      ok: true,
      latencyMs: 40,
      modelCount: 0,
    })

    const outcome = await checkProviderKey(openrouter(), 'sk-or-v1-x', hub)

    expect(outcome).toEqual({ kind: 'verified' })
    expect(checkProviderKeyUrl).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: 'sk-or-v1-x' }),
      'https://openrouter.ai/api/v1/key'
    )
    expect(checkProviderEndpoint).not.toHaveBeenCalled()
  })

  it('refuses a key the key-check endpoint answers 401', async () => {
    const { hub, checkProviderKeyUrl } = hubWith()
    checkProviderKeyUrl.mockResolvedValue(
      failed(
        401,
        'Authentication failed: an API key is required or invalid for OpenRouter.',
        '{"error":{"message":"User not found.","code":401}}'
      )
    )

    expect(
      (await checkProviderKey(openrouter(), 'invalid-qa-test-key', hub)).kind
    ).toBe('refused')
  })

  it('falls back to the model list without one, or for a moved base URL', async () => {
    const { hub, checkProviderKeyUrl, checkProviderEndpoint } = hubWith()
    // The model list refuses the key: what that check says is the outcome.
    checkProviderEndpoint.mockResolvedValue(
      failed(401, 'Authentication failed', OPENAI_INVALID_KEY)
    )

    const plain = await checkProviderKey(openai(), 'sk-x', hub)
    const moved = await checkProviderKey(
      openai({
        provider: 'huggingface',
        base_url: 'https://my-gateway.example/v1',
        key_check: { url: 'https://huggingface.co/api/whoami-v2' },
      }),
      'hf_x',
      hub
    )

    expect(plain.kind).toBe('refused')
    expect(moved.kind).toBe('refused')
    expect(checkProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: 'https://my-gateway.example/v1' })
    )
    expect(checkProviderKeyUrl).not.toHaveBeenCalled()
  })
})

describe('key status', () => {
  beforeEach(() => {
    useProviderKeyStatusStore.setState({ statuses: {} })
  })

  it('remembers an unverified key, and forgets it once verified', () => {
    recordKeyCheck('openai', 'sk-1', {
      kind: 'unverified',
      message: 'Cannot connect',
    })
    expect(statusOf('sk-1')).toMatchObject({
      state: 'unverified',
      message: 'Cannot connect',
    })

    recordKeyCheck('openai', 'sk-1', { kind: 'verified' })
    expect(statusOf('sk-1')).toBeUndefined()
  })

  it('applies only to the key it was recorded for', () => {
    recordKeyCheck('openai', 'sk-1', { kind: 'unverified', message: 'x' })

    expect(statusOf('sk-2')).toBeUndefined()
    expect(keyStatusFor(openai({ api_key: '' }), statuses())).toBeUndefined()
  })
})

describe('what a chat says about the key', () => {
  beforeEach(() => {
    useProviderKeyStatusStore.setState({ statuses: {} })
  })

  it("marks the key rejected on the provider's invalid-key 401", () => {
    noteProviderRequestError(
      openai({ api_key: 'invalid-qa-test-key' }),
      apiCallError(401, OPENAI_INVALID_KEY)
    )

    expect(statusOf('invalid-qa-test-key')).toMatchObject({
      state: 'rejected',
    })
  })

  it("marks it on Gemini's invalid-key 400 too, and through a retry wrapper", () => {
    noteProviderRequestError(openai({ api_key: 'k' }), {
      name: 'AI_RetryError',
      lastError: apiCallError(
        400,
        '[{"error":{"message":"API key not valid. Please pass a valid API key."}}]'
      ),
    })

    expect(statusOf('k')?.state).toBe('rejected')
  })

  it.each([
    [
      'a 403 (moderation, region)',
      apiCallError(403, '{"error":{"message":"Forbidden by moderation"}}'),
    ],
    [
      "the Local API Server's own 401",
      apiCallError(401, 'Invalid or missing authorization token'),
    ],
    ['a 401 about missing scopes', apiCallError(401, OPENAI_MISSING_SCOPE)],
    ['a model the key may not use', apiCallError(404, 'model_not_found')],
    [
      'text that only mentions 401',
      new Error('upstream said 401 Unauthorized'),
    ],
    ['a dropped connection', new Error('socket hang up')],
  ])('leaves the key alone for %s', (_, error) => {
    noteProviderRequestError(openai({ api_key: 'sk-1' }), error)

    expect(statuses()).toEqual({})
  })

  it('ignores local engines, subscriptions and keyless servers', () => {
    const invalid = apiCallError(401, OPENAI_INVALID_KEY)
    noteProviderRequestError(
      openai({ provider: 'llamacpp-upstream', api_key: 'x', persist: true }),
      invalid
    )
    noteProviderRequestError(
      openai({ provider: 'chatgpt', api_key: 'x' }),
      invalid
    )
    noteProviderRequestError(
      openai({ provider: 'ollama', api_key: '' }),
      invalid
    )

    expect(statuses()).toEqual({})
  })

  it('clears what was recorded once a chat with that key is answered', () => {
    noteProviderRequestError(
      openai({ api_key: 'sk-1' }),
      apiCallError(401, OPENAI_INVALID_KEY)
    )
    recordKeyCheck('anthropic', 'sk-a', {
      kind: 'unverified',
      message: 'offline',
    })

    noteProviderRequestSucceeded(openai({ api_key: 'sk-1' }))
    noteProviderRequestSucceeded(
      openai({ provider: 'anthropic', api_key: 'sk-a' })
    )

    expect(statuses()).toEqual({})
  })
})
