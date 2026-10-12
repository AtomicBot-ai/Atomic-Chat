/**
 * Media job manager tests.
 *
 * These are the regression tests for couplings C10, C11 and C12 (plan §0.3):
 * a job that lived in one component's `useState` and died on unmount, a cancel
 * button that only stopped the UI watching, and a fixed 1s poll that never
 * backed off and never gave up.
 *
 * Everything here drives fake adapters through fake timers. No network, no
 * React - the manager is deliberately not React state, so it must be testable
 * without rendering anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  MediaCapabilities,
  MediaJobSnapshot,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  NormalizedMediaRequest,
} from '../contract'
import {
  MEDIA_POLL_BACKOFF_MS,
  MEDIA_POLL_CEILING_MS,
  MEDIA_POLL_MAX_CONSECUTIVE_FAILURES,
  MEDIA_SUBMIT_BACKOFF_MS,
  MEDIA_SUBMIT_MAX_ATTEMPTS,
  MEDIA_SUBSCRIBE_SILENCE_MS,
  createMediaJobManager,
  type MediaJobEntry,
} from '../jobManager'

// --- fixtures ---------------------------------------------------------------

const providerA: MediaProviderDescriptor = {
  id: 'worker',
  label: 'Radium Media Worker',
  kind: 'local_worker',
  adapter: 'atomic-media-worker',
  enabled: true,
  origin: 'builtin',
}

const providerB: MediaProviderDescriptor = {
  id: 'comfy',
  label: 'ComfyUI',
  kind: 'local_comfy',
  adapter: 'comfyui',
  enabled: true,
  origin: 'user',
}

function capabilities(
  providerId: string,
  features: MediaCapabilities['features']
): MediaCapabilities {
  return {
    contract_version: 2,
    provider_id: providerId,
    devices: [],
    models: [],
    features,
  }
}

function requestFor(
  providerId: string,
  clientJobId = '01JJOB000000000000000000'
): NormalizedMediaRequest {
  return {
    client_job_id: clientJobId,
    provider_id: providerId,
    model_id: `${providerId}:model`,
    task: 'text_to_image',
    params: { prompt: 'a red car' },
  }
}

function snapshot(
  request: NormalizedMediaRequest,
  state: MediaJobSnapshot['state'],
  extra: Partial<MediaJobSnapshot> = {}
): MediaJobSnapshot {
  return {
    client_job_id: request.client_job_id,
    provider_job_id: `${request.provider_id}-job`,
    provider_id: request.provider_id,
    state,
    outputs: [],
    error: null,
    ...extra,
  }
}

type FakeAdapter = MediaProviderAdapter & {
  poll: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
  cancel?: ReturnType<typeof vi.fn>
  subscribe?: ReturnType<typeof vi.fn>
  /** Test driver: push an event to whatever subscribed. */
  emit?: (snapshot: MediaJobSnapshot) => void
}

type AdapterOptions = {
  states?: MediaJobSnapshot['state'][]
  canCancel?: boolean
  canSubscribe?: boolean
  /** Make subscribe throw, as a transport that cannot open a socket would. */
  subscribeThrows?: boolean
  /**
   * An adapter whose unsubscribe does not actually detach - a leaky transport,
   * or one with a frame already queued. Lets a late event reach the manager
   * after it believes it has torn the stream down.
   */
  leakyUnsubscribe?: boolean
  pollRejectsWith?: Error | null
}

function fakeAdapter(
  descriptor: MediaProviderDescriptor,
  options: AdapterOptions = {}
): FakeAdapter {
  const states = [...(options.states ?? ['running'])]
  let listener: ((snapshot: MediaJobSnapshot) => void) | undefined
  let request: NormalizedMediaRequest | undefined

  const nextState = () =>
    (states.length > 1 ? states.shift() : states[0]) as MediaJobSnapshot['state']

  const adapter: FakeAdapter = {
    descriptor,
    health: vi.fn(async () => ({ state: 'online' as const })),
    capabilities: vi.fn(async () => capabilities(descriptor.id, {})),
    submit: vi.fn(async (req: NormalizedMediaRequest) => {
      request = req
      return snapshot(req, 'queued')
    }),
    poll: vi.fn(async () => {
      if (options.pollRejectsWith) throw options.pollRejectsWith
      return snapshot(request!, nextState())
    }),
  }

  if (options.canCancel) {
    adapter.cancel = vi.fn(async () => {})
  }

  if (options.canSubscribe) {
    adapter.subscribe = vi.fn(
      (_handle, onEvent: (snapshot: MediaJobSnapshot) => void) => {
        if (options.subscribeThrows) throw new Error('socket refused')
        listener = onEvent
        return () => {
          if (!options.leakyUnsubscribe) listener = undefined
        }
      }
    )
    adapter.emit = (next: MediaJobSnapshot) => listener?.(next)
  }

  return adapter
}

function harness(
  a: AdapterOptions = {},
  b: AdapterOptions = {},
  features: Record<string, MediaCapabilities['features']> = {}
) {
  const adapters: Record<string, FakeAdapter> = {
    worker: fakeAdapter(providerA, a),
    comfy: fakeAdapter(providerB, b),
  }
  const manager = createMediaJobManager({
    createAdapter: (descriptor) => adapters[descriptor.id]!,
    providers: () => [providerA, providerB],
    capabilitiesFor: (providerId) =>
      capabilities(providerId, features[providerId] ?? {}),
  })
  return { manager, adapters }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// --- C10: jobs are not component state --------------------------------------

describe('createMediaJobManager — independent, non-React job state', () => {
  it('tracks concurrent jobs on two providers without confusing them', async () => {
    const { manager, adapters } = harness(
      { states: ['running', 'succeeded'] },
      { states: ['queued', 'queued', 'failed'] }
    )

    await manager.submit(requestFor('worker', '01JWORKERJOB0000000000000'))
    await manager.submit(requestFor('comfy', '01JCOMFYJOB00000000000000'))

    await vi.advanceTimersByTimeAsync(MEDIA_POLL_BACKOFF_MS[0]!)

    expect(manager.get('01JWORKERJOB0000000000000')?.provider_id).toBe('worker')
    expect(manager.get('01JCOMFYJOB00000000000000')?.provider_id).toBe('comfy')
    // Each adapter saw only its own job.
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(1)
    expect(adapters.comfy!.poll).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(2)
  })

  it('keeps polling a job with nobody subscribed to the store', async () => {
    // C10: the job used to live in one component's useState and die on unmount.
    const { manager } = harness({ states: ['running', 'running', 'succeeded'] })
    await manager.submit(requestFor('worker'))

    // No store subscriber at any point - as if the route had been left.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(manager.get('01JJOB000000000000000000')?.state).toBe('succeeded')
  })

  it('records the submitted request alongside the snapshot', async () => {
    const { manager } = harness()
    const request = requestFor('worker')

    await manager.submit(request)

    // Provenance: Task 8's library and any "re-run" affordance need to know
    // what was actually asked for, not just what came back.
    expect(manager.get(request.client_job_id)?.request).toEqual(request)
  })
})

// --- C12: polling is fixed-rate and unbounded -------------------------------

describe('createMediaJobManager — backoff and give-up', () => {
  it('backs off 1s, 2s, 4s, 8s and then holds at the ceiling', async () => {
    const { manager, adapters } = harness({ states: ['running'] })
    await manager.submit(requestFor('worker'))
    const poll = adapters.worker!.poll

    expect(poll).toHaveBeenCalledTimes(0)

    for (const [index, interval] of MEDIA_POLL_BACKOFF_MS.entries()) {
      await vi.advanceTimersByTimeAsync(interval)
      expect(poll).toHaveBeenCalledTimes(index + 1)
    }

    // Capped from here on, not doubling to 16s.
    await vi.advanceTimersByTimeAsync(MEDIA_POLL_CEILING_MS)
    expect(poll).toHaveBeenCalledTimes(MEDIA_POLL_BACKOFF_MS.length + 1)
    await vi.advanceTimersByTimeAsync(MEDIA_POLL_CEILING_MS)
    expect(poll).toHaveBeenCalledTimes(MEDIA_POLL_BACKOFF_MS.length + 2)

    // And the slowing poll is still actually driving the job, not just firing.
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('running')
  })

  it('stops polling as soon as the job is terminal', async () => {
    const { manager, adapters } = harness({ states: ['succeeded'] })
    await manager.submit(requestFor('worker'))

    await vi.advanceTimersByTimeAsync(MEDIA_POLL_BACKOFF_MS[0]!)
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('succeeded')
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    // Still one poll, and the result is still the one that settled it.
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(1)
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('succeeded')
  })

  it('gives up after N consecutive poll failures instead of looping forever', async () => {
    const { manager, adapters } = harness({
      pollRejectsWith: new Error('worker unreachable'),
    })
    await manager.submit(requestFor('worker'))

    await vi.advanceTimersByTimeAsync(120_000)

    const job = manager.get('01JJOB000000000000000000')
    expect(job?.state).toBe('failed')
    // Retryable: the graph is fine, the transport was not. This is the one
    // failure the user can do something about, so it must not look like a
    // permanent one.
    expect(job?.error).toMatchObject({ retryable: true })
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(
      MEDIA_POLL_MAX_CONSECUTIVE_FAILURES
    )
  })

  it('forgets earlier failures once a poll succeeds', async () => {
    const adapter = fakeAdapter(providerA)
    let calls = 0
    adapter.poll = vi.fn(async () => {
      calls += 1
      // Fail just short of the give-up threshold, then recover, then run on.
      if (calls < MEDIA_POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error('transient')
      }
      return snapshot(requestFor('worker'), 'running')
    })

    const manager = createMediaJobManager({
      createAdapter: () => adapter,
      providers: () => [providerA],
      capabilitiesFor: (id) => capabilities(id, {}),
    })
    await manager.submit(requestFor('worker'))

    await vi.advanceTimersByTimeAsync(300_000)

    // Still alive: the counter reset, so it never reached the give-up point.
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('running')
  })
})

// --- C11: cancellation is a lie ---------------------------------------------

describe('createMediaJobManager — cancellation', () => {
  it('does not offer cancel when the provider cannot cancel', async () => {
    const { manager } = harness({ canCancel: false }, {}, {
      worker: { cancel: false },
    })
    await manager.submit(requestFor('worker'))

    expect(manager.canCancel('01JJOB000000000000000000')).toBe(false)
  })

  it('refuses a cancel it cannot honour rather than pretending', async () => {
    const { manager } = harness({ canCancel: false }, {}, {
      worker: { cancel: false },
    })
    await manager.submit(requestFor('worker'))

    // C11 was a cancel button that only stopped the UI watching. Silently
    // no-opping here would rebuild exactly that lie one layer up.
    await expect(
      manager.cancel('01JJOB000000000000000000')
    ).rejects.toThrow(/cannot cancel/i)
  })

  it('cancels for real on a capable provider and stops polling', async () => {
    const { manager, adapters } = harness({ canCancel: true }, {}, {
      worker: { cancel: true },
    })
    await manager.submit(requestFor('worker'))

    expect(manager.canCancel('01JJOB000000000000000000')).toBe(true)
    await manager.cancel('01JJOB000000000000000000')

    expect(adapters.worker!.cancel).toHaveBeenCalledTimes(1)
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('cancelled')

    const polls = adapters.worker!.poll.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(polls)
  })
})

// --- idempotency ------------------------------------------------------------

describe('createMediaJobManager — idempotency', () => {
  it('does not create a second job for a client_job_id it already has', async () => {
    const { manager, adapters } = harness()
    const request = requestFor('worker')

    await manager.submit(request)
    await manager.submit(request)

    // client_job_id is the idempotency key (contract jobs.ts). A double-click
    // must not put two jobs on the GPU.
    expect(adapters.worker!.submit).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
  })
})

// --- streaming preference ---------------------------------------------------

describe('createMediaJobManager — subscribe over poll', () => {
  it('subscribes instead of polling when the provider streams events', async () => {
    const { manager, adapters } = harness({ canSubscribe: true }, {}, {
      worker: { events: true },
    })
    const request = requestFor('worker')
    await manager.submit(request)

    expect(adapters.worker!.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MEDIA_POLL_BACKOFF_MS[0]!)
    expect(adapters.worker!.poll).not.toHaveBeenCalled()

    // The stream, not a poll, is what moves the job on.
    adapters.worker!.emit!(snapshot(request, 'running', { progress: 42 }))
    expect(manager.get(request.client_job_id)).toMatchObject({
      state: 'running',
      progress: 42,
    })
  })

  it('applies a streamed snapshot to the store', async () => {
    const { manager, adapters } = harness({ canSubscribe: true }, {}, {
      worker: { events: true },
    })
    const request = requestFor('worker')
    await manager.submit(request)

    adapters.worker!.emit!(snapshot(request, 'running', { progress: 42 }))

    expect(manager.get(request.client_job_id)?.progress).toBe(42)
  })

  it('falls back to polling when the stream cannot be opened', async () => {
    const { manager, adapters } = harness(
      { canSubscribe: true, subscribeThrows: true },
      {},
      { worker: { events: true } }
    )
    await manager.submit(requestFor('worker'))

    await vi.advanceTimersByTimeAsync(MEDIA_POLL_BACKOFF_MS[0]!)

    // Without the job being lost - the whole point of the fallback.
    expect(adapters.worker!.poll).toHaveBeenCalledTimes(1)
    expect(manager.get('01JJOB000000000000000000')).toBeDefined()
  })

  it('falls back to polling when a stream goes silent', async () => {
    const { manager, adapters } = harness({ canSubscribe: true }, {}, {
      worker: { events: true },
    })
    await manager.submit(requestFor('worker'))

    // The contract's `subscribe` has no error channel, so a socket that dies
    // quietly is indistinguishable from one with nothing to say. A watchdog is
    // the only thing standing between that and a job that never updates again.
    await vi.advanceTimersByTimeAsync(MEDIA_SUBSCRIBE_SILENCE_MS)
    await vi.advanceTimersByTimeAsync(MEDIA_POLL_BACKOFF_MS[0]!)

    expect(adapters.worker!.poll).toHaveBeenCalled()
    // The job is moving again, which is the point of the watchdog.
    expect(manager.get('01JJOB000000000000000000')?.state).toBe('running')
  })

  it('does not start the watchdog fallback while events keep arriving', async () => {
    const { manager, adapters } = harness({ canSubscribe: true }, {}, {
      worker: { events: true },
    })
    const request = requestFor('worker')
    await manager.submit(request)

    // Two thirds of the silence window, an event, then two thirds again.
    await vi.advanceTimersByTimeAsync(Math.floor(MEDIA_SUBSCRIBE_SILENCE_MS * 0.66))
    adapters.worker!.emit!(snapshot(request, 'running', { progress: 10 }))
    await vi.advanceTimersByTimeAsync(Math.floor(MEDIA_SUBSCRIBE_SILENCE_MS * 0.66))

    expect(adapters.worker!.poll).not.toHaveBeenCalled()
    // The streamed value is what the store still holds - nothing overwrote it.
    expect(manager.get(request.client_job_id)?.progress).toBe(10)
  })

  it('unsubscribes from the stream once the job is terminal', async () => {
    const { manager, adapters } = harness({ canSubscribe: true }, {}, {
      worker: { events: true },
    })
    const request = requestFor('worker')
    await manager.submit(request)

    adapters.worker!.emit!(snapshot(request, 'succeeded'))
    expect(manager.get(request.client_job_id)?.state).toBe('succeeded')

    // The fake's emit only reaches a listener that is still attached, so a
    // no-op here is the observable proof that the manager tore the stream down
    // rather than leaving a finished job holding a socket open.
    adapters.worker!.emit!(snapshot(request, 'running'))
    expect(manager.get(request.client_job_id)?.state).toBe('succeeded')
  })

  it('refuses to resurrect a finished job when a late frame still arrives', async () => {
    const { manager, adapters } = harness(
      { canSubscribe: true, leakyUnsubscribe: true },
      {},
      { worker: { events: true } }
    )
    const request = requestFor('worker')
    await manager.submit(request)

    adapters.worker!.emit!(snapshot(request, 'succeeded'))
    // Tearing the stream down is the first line of defence, but an adapter
    // whose unsubscribe leaks - or one with a frame already in flight - gets
    // past it. A terminal job is final regardless of who is still talking.
    adapters.worker!.emit!(snapshot(request, 'running', { progress: 5 }))

    expect(manager.get(request.client_job_id)?.state).toBe('succeeded')
    expect(manager.get(request.client_job_id)?.progress).not.toBe(5)
  })

  it('does not let a concurrent double-submit reach the provider twice', async () => {
    const { manager, adapters } = harness()
    const request = requestFor('worker')

    // Both calls start before either has written to the store - a double-click,
    // which a store-only idempotency check cannot catch.
    const results = await Promise.allSettled([
      manager.submit(request),
      manager.submit(request),
    ])

    expect(adapters.worker!.submit).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })
})

/**
 * Decision D8, answered by the user 2026-09-10: the caller resolves a blank
 * seed, not the provider.
 *
 * The manager is where that happens, because it is the last place that sees the
 * request before an adapter does and the first place that records it. The
 * promise these tests pin is narrow but load-bearing: WHAT WAS SUBMITTED AND
 * WHAT WAS RECORDED ARE THE SAME NUMBER. If those two ever diverge, provenance
 * lies and "re-run" silently produces a different image.
 */
describe('seed resolution (D8)', () => {
  const seedModel: MediaCapabilities = {
    contract_version: 2,
    provider_id: 'worker',
    devices: [],
    features: {},
    models: [
      {
        id: 'worker:model',
        provider_id: 'worker',
        local_id: 'model',
        label: 'Model',
        tasks: ['text_to_image'],
        params: {
          text_to_image: [
            { id: 'seed', type: 'seed', label: 'Seed', min: 0, max: 999 },
          ],
        },
      },
    ],
  }

  function managerWithSeeds(random: () => number) {
    const adapter = fakeAdapter(providerA)
    const manager = createMediaJobManager({
      createAdapter: () => adapter,
      providers: () => [providerA],
      capabilitiesFor: () => seedModel,
      random,
    })
    return { adapter, manager }
  }

  it('sends a resolved seed even though the user left it blank', async () => {
    const { adapter, manager } = managerWithSeeds(() => 0.5)

    await manager.submit(requestFor('worker'))

    const sent = adapter.submit.mock.calls[0]![0] as NormalizedMediaRequest
    expect(typeof sent.params.seed).toBe('number')
    expect(sent.params.seed).toBeGreaterThanOrEqual(0)
    expect(sent.params.seed).toBeLessThanOrEqual(999)

    manager.dispose()
  })

  it('records exactly the seed it submitted, so provenance cannot lie', async () => {
    const { adapter, manager } = managerWithSeeds(() => 0.25)

    const entry = await manager.submit(requestFor('worker'))

    const sent = adapter.submit.mock.calls[0]![0] as NormalizedMediaRequest
    expect(entry.request.params.seed).toBe(sent.params.seed)

    manager.dispose()
  })

  it('never overwrites a seed the user chose', async () => {
    const { adapter, manager } = managerWithSeeds(() => 0.5)

    const request = requestFor('worker')
    await manager.submit({ ...request, params: { ...request.params, seed: 7 } })

    const sent = adapter.submit.mock.calls[0]![0] as NormalizedMediaRequest
    expect(sent.params.seed).toBe(7)

    manager.dispose()
  })

  it('does not add a seed to a model that declares none', async () => {
    const adapter = fakeAdapter(providerA)
    const manager = createMediaJobManager({
      createAdapter: () => adapter,
      providers: () => [providerA],
      capabilitiesFor: () => capabilities('worker', {}),
      random: () => 0.5,
    })

    await manager.submit(requestFor('worker'))

    const sent = adapter.submit.mock.calls[0]![0] as NormalizedMediaRequest
    expect(sent.params).not.toHaveProperty('seed')

    manager.dispose()
  })
})

describe('createMediaJobManager — submit retry', () => {
  function managerWith(adapter: FakeAdapter) {
    return createMediaJobManager({
      createAdapter: () => adapter,
      providers: () => [providerA],
      capabilitiesFor: () => capabilities('worker', {}),
    })
  }

  it('retries a rate limit and then accepts the job', async () => {
    const adapter = fakeAdapter(providerA)
    let calls = 0
    adapter.submit = vi.fn(async (req: NormalizedMediaRequest) => {
      calls += 1
      if (calls === 1) {
        throw Object.assign(new Error('rate limited'), {
          retryable: true,
          retryAfterMs: 0,
        })
      }
      return snapshot(req, 'queued')
    })
    const manager = managerWith(adapter)

    const submitted = manager.submit(requestFor('worker'))
    await vi.advanceTimersByTimeAsync(MEDIA_SUBMIT_BACKOFF_MS[0]!)
    const entry = await submitted

    expect(adapter.submit).toHaveBeenCalledTimes(2)
    expect(entry.state).toBe('queued')
    manager.dispose()
  })

  it('does not retry an error the provider flags as non-retryable', async () => {
    const adapter = fakeAdapter(providerA)
    adapter.submit = vi.fn(async () => {
      throw Object.assign(new Error('invalid api key'), { retryable: false })
    })
    const manager = managerWith(adapter)

    await expect(manager.submit(requestFor('worker'))).rejects.toThrow(
      'invalid api key'
    )
    expect(adapter.submit).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('honours a Retry-After longer than the standard backoff', async () => {
    const adapter = fakeAdapter(providerA)
    let calls = 0
    adapter.submit = vi.fn(async (req: NormalizedMediaRequest) => {
      calls += 1
      if (calls === 1) {
        throw Object.assign(new Error('slow down'), {
          retryable: true,
          retryAfterMs: 5000,
        })
      }
      return snapshot(req, 'queued')
    })
    const manager = managerWith(adapter)

    const submitted = manager.submit(requestFor('worker'))
    await vi.advanceTimersByTimeAsync(MEDIA_SUBMIT_BACKOFF_MS[0]!)
    expect(adapter.submit).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000)
    await submitted
    expect(adapter.submit).toHaveBeenCalledTimes(2)
    manager.dispose()
  })

  it('gives up after the retry budget and surfaces the last error', async () => {
    const adapter = fakeAdapter(providerA)
    adapter.submit = vi.fn(async () => {
      throw Object.assign(new Error('provider down'), { retryable: true })
    })
    const manager = managerWith(adapter)

    const submitted = manager.submit(requestFor('worker'))
    const expectation = expect(submitted).rejects.toThrow('provider down')
    await vi.advanceTimersByTimeAsync(
      MEDIA_SUBMIT_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) + 1000
    )
    await expectation
    expect(adapter.submit).toHaveBeenCalledTimes(MEDIA_SUBMIT_MAX_ATTEMPTS)
    manager.dispose()
  })
})

describe('createMediaJobManager — durable history', () => {
  function entryFor(
    providerId: string,
    clientJobId: string,
    state: MediaJobSnapshot['state']
  ): MediaJobEntry {
    const request = requestFor(providerId, clientJobId)
    return {
      ...snapshot(request, state),
      request,
      submitted_at: 1_700_000_000_000,
      cancellable: false,
    }
  }

  function managerWith(persisted: MediaJobEntry[] = []) {
    const adapter = fakeAdapter(providerA)
    const saved: MediaJobEntry[][] = []
    const persist = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (jobs: MediaJobEntry[]) => {
        saved.push(jobs)
      }),
    }
    const manager = createMediaJobManager({
      createAdapter: () => adapter,
      providers: () => [providerA],
      capabilitiesFor: () => capabilities('worker', {}),
      persist,
    })
    return { adapter, manager, persist, saved }
  }

  it('writes jobs on change, stripped of their heavy outputs', async () => {
    const { manager, persist } = managerWith()

    await manager.submit(requestFor('worker'))

    expect(persist.save).toHaveBeenCalled()
    const written = persist.save.mock.calls[0]![0] as MediaJobEntry[]
    expect(written).toHaveLength(1)
    expect(written[0]!.client_job_id).toBe('01JJOB000000000000000000')
    expect(written[0]!.outputs).toBeUndefined()
    manager.dispose()
  })

  it('restores terminal jobs as history', async () => {
    const persisted = [
      entryFor('worker', '01JOLD000000000000000001', 'succeeded'),
    ]
    const { manager } = managerWith(persisted)

    await manager.load()

    expect(manager.get('01JOLD000000000000000001')?.state).toBe('succeeded')
    expect(manager.list()).toHaveLength(1)
    manager.dispose()
  })

  it('marks jobs interrupted by a reload as failed and retryable', async () => {
    const persisted = [
      entryFor('worker', '01JOLD000000000000000001', 'running'),
    ]
    const { manager } = managerWith(persisted)

    await manager.load()

    const job = manager.get('01JOLD000000000000000001')
    expect(job?.state).toBe('failed')
    expect(job?.error).toMatchObject({ code: 'interrupted', retryable: true })
    manager.dispose()
  })

  it('does not overwrite a live job with its stale persisted copy', async () => {
    const persisted = [
      entryFor('worker', '01JOLD000000000000000001', 'succeeded'),
    ]
    const { manager } = managerWith(persisted)

    await manager.submit(requestFor('worker', '01JOLD000000000000000001'))
    await manager.load()

    expect(manager.get('01JOLD000000000000000001')?.state).toBe('queued')
    manager.dispose()
  })
})
