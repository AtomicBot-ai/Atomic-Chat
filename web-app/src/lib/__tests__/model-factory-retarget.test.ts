import { describe, expect, it, vi } from 'vitest'
import {
  createLiveSessionFetch,
  retargetLocalRequest,
  withBearer,
} from '../model-factory'

describe('retargetLocalRequest', () => {
  it('moves a loopback request to the port the model is actually on', () => {
    // The case this exists for: the engine reloaded the model with a larger context, so it answers
    // on a new port, while the model object was built for the old one.
    expect(
      retargetLocalRequest('http://localhost:3001/v1/chat/completions', 3999)
    ).toBe('http://localhost:3999/v1/chat/completions')
    expect(
      retargetLocalRequest('http://127.0.0.1:3001/v1/embeddings', 4100)
    ).toBe('http://127.0.0.1:4100/v1/embeddings')
  })

  it('leaves the request alone when it is already pointed at the right port', () => {
    const input = 'http://localhost:3001/v1/chat/completions'

    expect(retargetLocalRequest(input, 3001)).toBe(input)
  })

  it('never rewrites a request that is not local', () => {
    const cloud = 'https://api.example.com/v1/chat/completions'

    expect(retargetLocalRequest(cloud, 3999)).toBe(cloud)
  })

  it('keeps the path, query and method of a Request object', () => {
    const request = new Request(
      'http://localhost:3001/v1/chat/completions?stream=true',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }
    )

    const retargeted = retargetLocalRequest(request, 3999) as Request

    expect(retargeted.url).toBe(
      'http://localhost:3999/v1/chat/completions?stream=true'
    )
    expect(retargeted.method).toBe('POST')
    expect(retargeted.headers.get('content-type')).toBe('application/json')
  })

  it('accepts a URL object as well as a string', () => {
    const url = new URL('http://localhost:3001/v1/models')

    expect(retargetLocalRequest(url, 3999)).toBe(
      'http://localhost:3999/v1/models'
    )
  })
})

describe('withBearer', () => {
  it('replaces the key without disturbing other headers', () => {
    const headers = new Headers(
      withBearer(
        { headers: { Origin: 'tauri://localhost' } },
        'new-key'
      )!.headers
    )

    expect(headers.get('Authorization')).toBe('Bearer new-key')
    expect(headers.get('Origin')).toBe('tauri://localhost')
  })

  it('removes the header entirely when the session has no key', () => {
    // MLX sessions have none: mlx-vlm has no auth layer and binds to loopback only.
    const headers = new Headers(
      withBearer({ headers: { Authorization: 'Bearer stale' } }, '')!.headers
    )

    expect(headers.get('Authorization')).toBeNull()
  })

  it('works when the caller passed no init at all', () => {
    const headers = new Headers(withBearer(undefined, 'k')!.headers)

    expect(headers.get('Authorization')).toBe('Bearer k')
  })
})

describe('createLiveSessionFetch', () => {
  it('uses the freshly resolved port and bearer instead of the model object target', async () => {
    const response = new Response('ok')
    const baseFetch = vi.fn().mockResolvedValue(response)
    const liveFetch = createLiveSessionFetch(baseFetch, async () => ({
      pid: 2,
      port: 3999,
      model_id: 'm',
      model_path: '/m.gguf',
      is_embedding: false,
      api_key: 'fresh-key',
    }))

    await expect(
      liveFetch('http://localhost:3001/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer stale-key' },
      })
    ).resolves.toBe(response)

    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(baseFetch.mock.calls[0]?.[0]).toBe(
      'http://localhost:3999/v1/chat/completions'
    )
    expect(
      new Headers(baseFetch.mock.calls[0]?.[1]?.headers).get('Authorization')
    ).toBe('Bearer fresh-key')
  })

  it('does not send anything when a fresh target cannot be resolved', async () => {
    const baseFetch = vi.fn()
    const liveFetch = createLiveSessionFetch(baseFetch, async () => {
      throw new Error('core detached')
    })

    await expect(
      liveFetch('http://localhost:3001/v1/chat/completions', {
        headers: { Authorization: 'Bearer stale-key' },
      })
    ).rejects.toThrow('core detached')
    expect(baseFetch).not.toHaveBeenCalled()
  })
})
