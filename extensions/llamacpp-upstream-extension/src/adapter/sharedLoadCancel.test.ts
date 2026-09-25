/**
 * The cancel protocol the three runtime extensions share, on top of the core's load
 * (`extensions/shared/loadCancel.ts`).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  codedError,
  LoadCancelTracker,
  loadCancelledError,
  MODEL_LOAD_CANCELLED,
  toLoadError,
} from '../../../shared/loadCancel'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function tracker(answers: { cancelLoad?: () => Promise<boolean>; unload?: () => Promise<unknown> } = {}) {
  const warnings: string[] = []
  const core = {
    cancelLoad: vi.fn(answers.cancelLoad ?? (async () => true)),
    unload: vi.fn(answers.unload ?? (async () => ({ success: true }))),
  }
  return { core, warnings, tracker: new LoadCancelTracker(core, (m) => warnings.push(m), 1) }
}

describe('LoadCancelTracker', () => {
  it('answers false for a model nobody is loading', async () => {
    const { tracker: t, core } = tracker()
    expect(await t.cancelLoad('m')).toBe(false)
    expect(core.cancelLoad).not.toHaveBeenCalled()
  })

  it('cancels a load the core has registered: true, and the load rejects', async () => {
    const { tracker: t, core } = tracker()
    let reject!: (e: unknown) => void
    const load = t.track('m', () =>
      t.loadInCore('m', () => new Promise<{ pid: number }>((_, r) => (reject = r)))
    )
    await tick()
    expect(t.isLoading('m')).toBe(true)
    expect(await t.cancelLoad('m')).toBe(true)
    expect(core.cancelLoad).toHaveBeenCalledTimes(1)
    reject(codedError(MODEL_LOAD_CANCELLED, 'The model load was cancelled.'))
    await expect(load).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(t.isLoading('m')).toBe(false)
    // A later cancel of the same model finds nothing.
    expect(await t.cancelLoad('m')).toBe(false)
  })

  it('retries while the request has not reached the core, and stops once it did', async () => {
    let seen = 0
    const { tracker: t, core } = tracker({ cancelLoad: async () => ++seen >= 3 })
    let resolve!: (v: { pid: number }) => void
    const load = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((r) => (resolve = r))))
    await tick()
    expect(await t.cancelLoad('m')).toBe(true)
    expect(core.cancelLoad).toHaveBeenCalledTimes(3)
    // The core answered the load before its cancel took: the session is unloaded again.
    resolve({ pid: 7 })
    await expect(load).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(core.unload).toHaveBeenCalledWith('m')
  })

  it('stops chasing a cancel that fails outright, and still takes the session down', async () => {
    const { tracker: t, core, warnings } = tracker({
      cancelLoad: async () => {
        throw new Error('core gone')
      },
      unload: async () => {
        throw new Error('unload failed')
      },
    })
    let resolve!: (v: { pid: number }) => void
    const load = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((r) => (resolve = r))))
    await tick()
    expect(await t.cancelLoad('m')).toBe(true)
    expect(core.cancelLoad).toHaveBeenCalledTimes(1)
    resolve({ pid: 7 })
    await expect(load).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(warnings).toEqual([
      'cancelling the load of "m" failed: Error: core gone',
      'Failed to stop "m" after its load was cancelled: Error: unload failed',
    ])
  })

  it('names the code and message of a core failure in its warnings', async () => {
    // Failures cross `invoke` as plain `{code, message, details}` objects, not Errors.
    const { tracker: t, warnings } = tracker({
      cancelLoad: async () => {
        throw { code: 'INVALID_ARGUMENT', message: 'No such control route', details: 'POST /load/cancel' }
      },
      unload: async () => {
        throw { code: 'CORE_NOT_RUNNING', message: 'The core is stopping.' }
      },
    })
    let resolve!: (v: { pid: number }) => void
    const load = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((r) => (resolve = r))))
    await tick()
    expect(await t.cancelLoad('m')).toBe(true)
    resolve({ pid: 7 })
    await expect(load).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(warnings).toEqual([
      'cancelling the load of "m" failed: No such control route (POST /load/cancel) [INVALID_ARGUMENT]',
      'Failed to stop "m" after its load was cancelled: The core is stopping. [CORE_NOT_RUNNING]',
    ])
  })

  it('stops a load at its next checkpoint when the cancel came before the core request', async () => {
    const { tracker: t, core } = tracker()
    let go!: () => void
    const gate = new Promise<void>((r) => (go = r))
    const load = t.track('m', async () => {
      await gate
      t.throwIfCancelled('m')
      return t.loadInCore('m', async () => ({ pid: 1 }))
    })
    await tick()
    expect(await t.cancelLoad('m')).toBe(true)
    expect(core.cancelLoad, 'nothing was outstanding in the core').not.toHaveBeenCalled()
    go()
    await expect(load).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    // And `loadInCore` itself refuses to start after a cancel.
    const late = t.track('m', async () => {
      await t.cancelLoad('m')
      return t.loadInCore('m', async () => ({ pid: 2 }))
    })
    await expect(late).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
  })

  it('keeps the cancel mark while another load of the same model is still running', async () => {
    const { tracker: t } = tracker()
    let finishFirst!: (v: { pid: number }) => void
    const first = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((r) => (finishFirst = r))))
    let finishSecond!: (v: { pid: number }) => void
    const second = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((r) => (finishSecond = r))))
    await tick()
    await t.cancelLoad('m')
    finishFirst({ pid: 1 })
    await expect(first).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(t.isLoading('m')).toBe(true)
    finishSecond({ pid: 2 })
    await expect(second).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(t.isLoading('m')).toBe(false)
  })

  it('still asks the core while another request for the model is outstanding there', async () => {
    // Two loads of one model overlap (nothing dedupes them upstream); the first settles, the
    // second is still queued in the core, and the cancel has to reach it.
    const { tracker: t, core } = tracker()
    let failFirst!: (e: unknown) => void
    const first = t.track('m', () => t.loadInCore('m', () => new Promise<{ pid: number }>((_, r) => (failFirst = r))))
    let rejectSecond!: (e: unknown) => void
    const second = t.track('m', () =>
      t.loadInCore('m', () => new Promise<{ pid: number }>((_, r) => (rejectSecond = r)))
    )
    await tick()
    failFirst({ code: 'OUT_OF_MEMORY', message: 'oom' })
    await expect(first).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })
    expect(await t.cancelLoad('m')).toBe(true)
    expect(core.cancelLoad).toHaveBeenCalledTimes(1)
    expect(core.cancelLoad).toHaveBeenCalledWith('m')
    rejectSecond(codedError(MODEL_LOAD_CANCELLED, 'The model load was cancelled.'))
    await expect(second).rejects.toMatchObject({ code: MODEL_LOAD_CANCELLED })
    expect(t.isLoading('m')).toBe(false)
  })
})

describe('toLoadError', () => {
  it('keeps the core code and details on an Error the web app can read', () => {
    const error = toLoadError({ code: 'MODEL_FILE_NOT_FOUND', message: 'Model file not found.', details: '/m.gguf' })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: 'Model file not found. (/m.gguf) [MODEL_FILE_NOT_FOUND]',
      details: '/m.gguf',
    })
    expect(toLoadError({ code: 'OUT_OF_MEMORY', message: 'oom' })).toMatchObject({ message: 'oom [OUT_OF_MEMORY]' })
    const plain = new Error('x')
    expect(toLoadError(plain)).toBe(plain)
    expect(toLoadError('text')).toBe('text')
    expect(loadCancelledError()).toMatchObject({ code: MODEL_LOAD_CANCELLED, message: 'The model load was cancelled.' })
  })
})
