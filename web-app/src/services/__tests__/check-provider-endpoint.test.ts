import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { checkProviderEndpoint } from '../providers/tauri'

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
})
