import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureEmbeddingsReady,
  resetEmbeddingsWarmupForTest,
} from '@/lib/ensure-embeddings'

type CoreWindow = Window & {
  core?: {
    extensionManager?: { getByName: (name: string) => unknown }
  }
}

const coreWindow = window as CoreWindow

const installEngine = (embed: (texts: string[]) => Promise<unknown>) => {
  coreWindow.core = {
    extensionManager: {
      getByName: (name: string) =>
        name === '@janhq/llamacpp-upstream-extension' ? { embed } : undefined,
    },
  }
}

describe('ensureEmbeddingsReady', () => {
  beforeEach(() => {
    resetEmbeddingsWarmupForTest()
  })

  afterEach(() => {
    delete coreWindow.core
    vi.useRealTimers()
  })

  it('warms up once and memoizes success', async () => {
    const embed = vi.fn().mockResolvedValue({ data: [] })
    installEngine(embed)

    const first = ensureEmbeddingsReady()
    await first
    const second = ensureEmbeddingsReady()
    await expect(second).resolves.toBeUndefined()

    // Memoized: a later send gets the settled warm-up, not a new attempt.
    expect(second).toBe(first)
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed).toHaveBeenCalledWith(['warmup'])
  })

  it('shares one in-flight warm-up between concurrent sends', async () => {
    let release: (() => void) | undefined
    const embed = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: [] })
        })
    )
    installEngine(embed)

    const first = ensureEmbeddingsReady()
    const second = ensureEmbeddingsReady()
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])

    // Both sends wait on the very same warm-up.
    expect(second).toBe(first)
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('never throws and retries after a failure', async () => {
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new Error('model not ready'))
      .mockResolvedValueOnce({ data: [] })
    installEngine(embed)

    await expect(ensureEmbeddingsReady()).resolves.toBeUndefined()
    await expect(ensureEmbeddingsReady()).resolves.toBeUndefined()

    expect(embed).toHaveBeenCalledTimes(2)
  })

  it('resolves without an engine instead of blocking the send', async () => {
    delete coreWindow.core
    await expect(ensureEmbeddingsReady()).resolves.toBeUndefined()
  })

  it('gives up after the warm-up timeout', async () => {
    vi.useFakeTimers()
    installEngine(() => new Promise(() => {}))

    const pending = ensureEmbeddingsReady()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toBeUndefined()
  })
})
