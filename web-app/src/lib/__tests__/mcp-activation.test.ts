import { afterEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

import {
  awaitMcpActivations,
  settleMcpActivationsBeforeSend,
  trackMcpActivation,
} from '../mcp-activation'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  toastMocks.warning.mockReset()
})

describe('awaitMcpActivations', () => {
  it('returns at once when nothing is connecting', async () => {
    expect(await awaitMcpActivations()).toBe('none')
  })

  it('waits until a connecting server settles, success or failure', async () => {
    const ok = deferred()
    const failing = deferred()
    trackMcpActivation('exa', ok.promise)
    trackMcpActivation('linear', failing.promise)

    const waiting = awaitMcpActivations()
    ok.resolve()
    failing.reject(new Error('handshake failed'))

    expect(await waiting).toBe('settled')
    expect(await awaitMcpActivations()).toBe('none')
  })

  it('gives up after the timeout and says so before a send', async () => {
    vi.useFakeTimers()
    const stuck = deferred()
    trackMcpActivation('exa', stuck.promise)

    const waiting = settleMcpActivationsBeforeSend()
    await vi.advanceTimersByTimeAsync(12_000)

    expect(await waiting).toBe('timeout')
    expect(toastMocks.warning).toHaveBeenCalledTimes(1)
    stuck.resolve()
    await vi.runAllTimersAsync()
    expect(await awaitMcpActivations()).toBe('none')
  })

  it('stops waiting when the send is aborted', async () => {
    const stuck = deferred()
    trackMcpActivation('exa', stuck.promise)
    const controller = new AbortController()

    const waiting = awaitMcpActivations({ signal: controller.signal })
    controller.abort()

    expect(await waiting).toBe('aborted')
    stuck.resolve()
    await stuck.promise
  })
})
