import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMediaAdapter } from '../providerFactory'
import { createReplicateAdapter } from '../adapters/replicate'
import { readMediaSecret } from '../secrets'
import { MEDIA_TASK } from '../contract'
import type {
  MediaProviderAdapterId,
  MediaProviderDescriptor,
} from '../contract'

vi.mock('../secrets', () => ({ readMediaSecret: vi.fn() }))

function provider(adapter: MediaProviderAdapterId): MediaProviderDescriptor {
  return {
    id: adapter,
    label: adapter,
    adapter,
    kind: adapter === 'a1111' ? 'local_worker' : 'remote_http',
    enabled: true,
    origin: 'user',
    // A local A1111 normally needs nothing; the cloud services need a key.
    auth:
      adapter === 'a1111'
        ? { type: 'none' }
        : { type: 'api_key', setting_key: `media.${adapter}.api_key` },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('new media adapters through the production factory', () => {
  it('discovers A1111 models with usable prompt controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: 'Model A', model_name: 'model-a' }],
      })
    )
    const adapter = createMediaAdapter(provider('a1111'))
    const capabilities = await adapter.capabilities()
    const model = capabilities.models[0]
    expect(model?.id).toBe('a1111:model-a')
    expect(model?.params[MEDIA_TASK.TEXT_TO_IMAGE]).toContainEqual(
      expect.objectContaining({ id: 'prompt', required: true })
    )
  })

  it.each([
    [
      'replicate',
      'Bearer test-secret',
      { id: 'prediction-1', status: 'starting' },
    ],
    ['fal-ai', 'Key test-secret', { request_id: 'request-1' }],
    ['stability-ai', 'Bearer test-secret', { image: 'aW1hZ2U=' }],
  ] as const)(
    'resolves the OS credential for %s submissions',
    async (id, authorization, payload) => {
      vi.mocked(readMediaSecret).mockResolvedValue('test-secret')
      const transport = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => payload })
      vi.stubGlobal('fetch', transport)
      const adapter = createMediaAdapter(provider(id))
      await adapter.submit({
        client_job_id: 'job-1',
        provider_id: id,
        model_id: `${id}:model-1`,
        task: MEDIA_TASK.TEXT_TO_IMAGE,
        params: { prompt: 'test' },
      })
      expect(readMediaSecret).toHaveBeenCalledWith(`media.${id}.api_key`)
      expect(transport).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: authorization }),
        })
      )
    }
  )

  it('keeps fal.ai status and output requests on the configured provider URL', async () => {
    vi.mocked(readMediaSecret).mockResolvedValue('test-secret')
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ request_id: 'request-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'COMPLETED' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          images: [{ url: 'https://example.com/image.png' }],
        }),
      })
    vi.stubGlobal('fetch', transport)
    const adapter = createMediaAdapter({
      ...provider('fal-ai'),
      base_url: 'https://gateway.example.com/',
    })
    const job = await adapter.submit({
      client_job_id: 'job-1',
      provider_id: 'fal-ai',
      model_id: 'fal-ai:custom/model',
      task: MEDIA_TASK.TEXT_TO_IMAGE,
      params: { prompt: 'test' },
    })
    await adapter.poll(job)
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example.com/custom/model',
      'https://gateway.example.com/custom/model/requests/request-1/status',
      'https://gateway.example.com/custom/model/requests/request-1',
    ])
  })
})

describe('Replicate cancellation', () => {
  const handle = { client_job_id: 'job-1', provider_job_id: 'prediction-1' }

  it.each([401, 500])(
    'rejects HTTP %s so the manager keeps tracking the job',
    async (status) => {
      const adapter = createReplicateAdapter(provider('replicate'), {
        resolveSecret: async () => 'test-secret',
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => ({ detail: 'Cancellation refused' }),
        }),
      })
      await expect(adapter.cancel?.(handle)).rejects.toMatchObject({ status })
    }
  )

  it('propagates a transport failure', async () => {
    const adapter = createReplicateAdapter(provider('replicate'), {
      resolveSecret: async () => 'test-secret',
      fetch: vi.fn().mockRejectedValue(new Error('Network unavailable')),
    })
    await expect(adapter.cancel?.(handle)).rejects.toThrow(
      'Network unavailable'
    )
  })

  it('accepts a successful cancellation', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true })
    const adapter = createReplicateAdapter(provider('replicate'), {
      resolveSecret: async () => 'test-secret',
      fetch: transport,
    })
    await expect(adapter.cancel?.(handle)).resolves.toBeUndefined()
    expect(transport).toHaveBeenCalledWith(
      'https://api.replicate.com/v1/predictions/prediction-1/cancel',
      expect.objectContaining({ method: 'POST' })
    )
  })
})
