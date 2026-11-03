import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  checkProviderEndpoint,
  checkProviderKeyUrl,
  TauriProvidersService,
} from '../providers/tauri'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'

const provider = (overrides: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    provider: 'lan-vllm',
    active: true,
    models: [],
    settings: [],
    base_url: 'http://192.168.1.20:8000',
    ...overrides,
  }) as ModelProvider

const models = (...ids: string[]) =>
  JSON.stringify({ data: ids.map((id) => ({ id })) })

describe('checkProviderEndpoint', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('asks the model listing once, with an 8 s timeout, and counts the models', async () => {
    invoke.mockResolvedValueOnce(models('a', 'b', 'b', 'c'))

    const result = await checkProviderEndpoint(
      provider({ base_url: ' http://192.168.1.20:8000/v1/ ', api_key: 'sk-x' })
    )

    expect(result).toMatchObject({ ok: true, modelCount: 3 })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_local_http', {
      url: 'http://192.168.1.20:8000/v1/models',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-x' }),
      timeoutSecs: 8,
    })
  })

  it('tries /v1/models after a 404 on /models', async () => {
    invoke
      .mockRejectedValueOnce(new Error('HTTP 404: 404 page not found'))
      .mockResolvedValueOnce(models('llama3'))

    const result = await checkProviderEndpoint(provider())

    expect(result).toMatchObject({ ok: true, modelCount: 1 })
    expect(invoke.mock.calls.map(([, args]) => args.url)).toEqual([
      'http://192.168.1.20:8000/models',
      'http://192.168.1.20:8000/v1/models',
    ])
  })

  it('does not retry a server that is not there, and says what to check', async () => {
    invoke.mockRejectedValueOnce(
      new Error('Request failed: connection refused')
    )

    const result = await checkProviderEndpoint(provider())

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result.modelCount).toBe(0)
    expect(result.message).toBe(
      'Cannot connect to Lan-vllm at http://192.168.1.20:8000. Check that the server is running and the address is correct.'
    )
  })

  it.each([
    ['ollama', 'Ollama'],
    ['llamacpp-server', 'llama.cpp server'],
  ])('names the %s provider by its display name', async (id, title) => {
    invoke.mockRejectedValueOnce(
      new Error('Request failed: connection refused')
    )

    const result = await checkProviderEndpoint(
      provider({ provider: id, base_url: 'http://localhost:11434/v1' })
    )

    expect(result.message).toBe(
      `Cannot connect to ${title} at http://localhost:11434/v1. Check that the server is running and the address is correct.`
    )
  })

  it('names the provider by its display name when the answer is not a model list', async () => {
    invoke.mockResolvedValueOnce('<html>router login</html>')

    const result = await checkProviderEndpoint(
      provider({ provider: 'ollama', base_url: 'http://localhost:11434/v1' })
    )

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(
      /^Failed to parse JSON response from Ollama: /
    )
  })

  it('reports a rejected key', async () => {
    invoke.mockRejectedValueOnce(new Error('HTTP 401: Unauthorized'))

    const result = await checkProviderEndpoint(provider())

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/^Authentication failed/)
  })

  it('names both paths when neither has a model listing', async () => {
    invoke
      .mockRejectedValueOnce(new Error('HTTP 404: not found'))
      .mockRejectedValueOnce(new Error('HTTP 404: not found'))

    const result = await checkProviderEndpoint(provider())

    expect(result.ok).toBe(false)
    expect(result.message).toContain(
      'http://192.168.1.20:8000/models and http://192.168.1.20:8000/v1/models'
    )
  })

  it('treats an answer that is not a model list as a failure', async () => {
    invoke.mockResolvedValueOnce('<html>router login</html>')

    const result = await checkProviderEndpoint(provider())

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Failed to parse JSON response/)
  })

  it('needs an address before it asks anything', async () => {
    const result = await checkProviderEndpoint(provider({ base_url: '  ' }))

    expect(result.ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('carries the HTTP status a refused key came back with', async () => {
    invoke.mockRejectedValueOnce(
      new Error('HTTP 401: {"error":{"code":"invalid_api_key"}}')
    )

    const result = await checkProviderEndpoint(provider({ api_key: 'bad' }))

    // The body is kept: it tells an invalid key from one without permission.
    expect(result).toMatchObject({
      ok: false,
      httpStatus: 401,
      responseBody: '{"error":{"code":"invalid_api_key"}}',
    })
  })

  it('has no HTTP status for a server that never answered', async () => {
    invoke.mockRejectedValueOnce(new Error('Request failed: timed out'))

    const result = await checkProviderEndpoint(provider())

    expect(result.httpStatus).toBeUndefined()
  })

  it("refuses the app's own Local API Server without asking it", async () => {
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
    })

    const result = await checkProviderEndpoint(
      provider({ base_url: 'http://localhost:1337/v1' })
    )

    expect(result.ok).toBe(false)
    expect(result.message).toBe(
      "Lan-vllm points at Atomic Chat's own Local API Server (http://127.0.0.1:1337/v1). Use the address of the server you want to reach."
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('fetchModelsFromProvider', () => {
  beforeEach(() => {
    invoke.mockReset()
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
    })
  })

  it("does not take the app's own models for an endpoint pointing back at it", async () => {
    await expect(
      new TauriProvidersService().fetchModelsFromProvider(
        provider({ base_url: 'http://127.0.0.1:1337/v1' })
      )
    ).rejects.toThrow('own Local API Server (http://127.0.0.1:1337/v1)')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('checkProviderKeyUrl', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  const huggingface = provider({
    provider: 'huggingface',
    base_url: 'https://router.huggingface.co/v1',
    api_key: 'hf_x',
  })

  it('asks the key-check URL once with the key, and takes any 2xx body', async () => {
    invoke.mockResolvedValueOnce('{"name":"someone","type":"user"}')

    const result = await checkProviderKeyUrl(
      huggingface,
      'https://huggingface.co/api/whoami-v2'
    )

    expect(result).toMatchObject({ ok: true, modelCount: 0 })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_local_http', {
      url: 'https://huggingface.co/api/whoami-v2',
      headers: expect.objectContaining({ Authorization: 'Bearer hf_x' }),
      timeoutSecs: 8,
    })
  })

  it('carries a refusal’s status and body', async () => {
    invoke.mockRejectedValueOnce(
      new Error(
        'HTTP 401: {"error":"Invalid credentials in Authorization header"}'
      )
    )

    const result = await checkProviderKeyUrl(
      huggingface,
      'https://huggingface.co/api/whoami-v2'
    )

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 401,
      responseBody: '{"error":"Invalid credentials in Authorization header"}',
    })
    expect(result.message).toMatch(/^Authentication failed/)
  })

  it('does not call a missing key-check route a missing model list', async () => {
    invoke.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))

    const result = await checkProviderKeyUrl(
      huggingface,
      'https://huggingface.co/api/whoami-v2'
    )

    expect(result.httpStatus).toBe(404)
    expect(result.message).toBe(
      'Cannot check the API key with Hugging Face at https://huggingface.co/api/whoami-v2: HTTP 404: Not Found'
    )
  })
})
