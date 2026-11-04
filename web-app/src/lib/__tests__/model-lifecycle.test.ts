import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  heldModels,
  holdModel,
  holdModelUntilFirstRequest,
  pendingModelStart,
  resetModelLifecycleForTests,
  shareModelStart,
  waitForModelHolds,
} from '@/lib/model-lifecycle'

beforeEach(() => resetModelLifecycleForTests())
afterEach(() => vi.useRealTimers())

describe('shared model starts', () => {
  it('hands a later caller the start already under way, until it settles', async () => {
    let finish!: () => void
    const start = new Promise<void>((resolve) => {
      finish = resolve
    })
    const shared = shareModelStart('llamacpp-upstream', 'qwen', start)

    expect(pendingModelStart('llamacpp-upstream', 'qwen')).toBe(shared)
    // Keyed by provider and model: the same id on another engine is another start.
    expect(pendingModelStart('llamacpp', 'qwen')).toBeUndefined()

    finish()
    await shared
    await Promise.resolve()
    expect(pendingModelStart('llamacpp-upstream', 'qwen')).toBeUndefined()
  })

  it('passes a failed start on to whoever joined it, and forgets it', async () => {
    const shared = shareModelStart(
      'mlx',
      'gemma',
      Promise.reject(new Error('out of memory'))
    )
    await expect(pendingModelStart('mlx', 'gemma')).rejects.toThrow(
      'out of memory'
    )
    await expect(shared).rejects.toThrow('out of memory')
    expect(pendingModelStart('mlx', 'gemma')).toBeUndefined()
  })

  it('keeps the newer start when an older one settles after it was replaced', async () => {
    let finishOld!: () => void
    shareModelStart(
      'mlx',
      'gemma',
      new Promise<void>((resolve) => {
        finishOld = resolve
      })
    )
    const newer = shareModelStart('mlx', 'gemma', new Promise<void>(() => {}))
    finishOld()
    await Promise.resolve()
    await Promise.resolve()
    expect(pendingModelStart('mlx', 'gemma')).toBe(newer)
  })
})

describe('model holds', () => {
  it('lists a model while a request holds it, and not after', () => {
    const hold = holdModel('llamacpp-upstream', 'qwen', 60_000)
    expect(heldModels()).toEqual([
      { provider: 'llamacpp-upstream', modelId: 'qwen' },
    ])
    hold.release()
    hold.release()
    expect(heldModels()).toEqual([])
  })

  it('lets a hold that goes quiet lapse, and a touched one live on', () => {
    vi.useFakeTimers()
    const quiet = holdModel('llamacpp-upstream', 'quiet', 1_000)
    const busy = holdModel('llamacpp-upstream', 'busy', 1_000)
    vi.advanceTimersByTime(800)
    busy.touch()
    vi.advanceTimersByTime(800)
    expect(heldModels().map((ref) => ref.modelId)).toEqual(['busy'])
    quiet.release()
  })

  it('keeps one first-request hold per model: the newer replaces the older', () => {
    const older = holdModelUntilFirstRequest('openai', 'gpt', 60_000)
    const newer = holdModelUntilFirstRequest('openai', 'gpt', 60_000)
    older()
    expect(heldModels()).toEqual([{ provider: 'openai', modelId: 'gpt' }])
    newer()
    expect(heldModels()).toEqual([])
  })

  it('waits until the matching holds are released', async () => {
    const hold = holdModel('llamacpp-upstream', 'qwen', 60_000)
    holdModel('openai', 'gpt', 60_000)
    let done = false
    const waiting = waitForModelHolds(
      (ref) => ref.provider === 'llamacpp-upstream'
    ).then((waited) => {
      done = true
      return waited
    })
    await Promise.resolve()
    expect(done).toBe(false)

    hold.release()
    await expect(waiting).resolves.toBe(true)
  })

  it('does not wait when nothing matches, and stops waiting when told to', async () => {
    await expect(waitForModelHolds(() => true)).resolves.toBe(false)

    vi.useFakeTimers()
    holdModel('mlx', 'gemma', 60_000)
    let stop = false
    const waiting = waitForModelHolds(
      () => true,
      () => stop
    )
    stop = true
    await vi.advanceTimersByTimeAsync(300)
    await expect(waiting).resolves.toBe(true)
  })
})
