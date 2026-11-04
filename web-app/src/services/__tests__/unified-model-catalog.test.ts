import { afterEach, expect, it, vi } from 'vitest'
import { fetch as nativeFetch } from '@tauri-apps/plugin-http'
import { nativeMetadata } from '../unified-model-catalog'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('detaches a completed native metadata response from a later deadline', async () => {
  let forwarded: AbortSignal | undefined
  vi.mocked(nativeFetch).mockImplementation(async (_input, init) => {
    forwarded = init?.signal ?? undefined
    return Response.json({ sha: 'a'.repeat(40) })
  })
  const controller = new AbortController()
  const response = await nativeMetadata(
    'https://huggingface.co/api/models/test/model',
    { signal: controller.signal }
  )
  expect(await response.json()).toEqual({ sha: 'a'.repeat(40) })
  controller.abort()
  expect(forwarded?.aborted).toBe(false)
})

it('cancels an unfinished native metadata request', async () => {
  vi.mocked(nativeFetch).mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('metadata cancelled')),
          { once: true }
        )
      })
  )
  const controller = new AbortController()
  const pending = nativeMetadata(
    'https://huggingface.co/api/models/test/model',
    { signal: controller.signal }
  )
  controller.abort()
  await expect(pending).rejects.toThrow('metadata cancelled')
})
