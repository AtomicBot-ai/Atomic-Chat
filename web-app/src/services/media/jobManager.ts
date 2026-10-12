/**
 * The cross-provider media job manager.
 *
 * One module-scoped singleton owning every in-flight media job, with a vanilla
 * Zustand store that React subscribes to but does not own. That inversion is
 * the whole fix for coupling C10: a job used to live in `useAtomicMediaJob`'s
 * `useState`, so navigating away from Media destroyed the UI's only record of
 * work that was still running on the GPU.
 *
 * It also closes the other two:
 *
 *  - **C11, cancellation was a lie.** The old `cancel` cleared a `setTimeout`
 *    and never told the worker. Here `cancel` calls the adapter, and is offered
 *    only when the provider actually reports `features.cancel`. Asking to
 *    cancel a provider that cannot throws rather than silently doing nothing -
 *    a no-op would rebuild the same lie one layer up.
 *  - **C12, polling was fixed-rate and unbounded.** A 1s poll re-armed on error
 *    forever. Here the interval backs off 1s -> 2s -> 4s -> 8s and holds at a
 *    ceiling, and N consecutive failures end the job as `failed` with
 *    `retryable: true` instead of looping.
 *
 * No React import. Nothing here may depend on a component being mounted.
 */

import { createStore, type StoreApi } from 'zustand/vanilla'

import { createMediaAdapter } from './providerFactory'
import { createMediaJobsStore } from './jobsStore'
import { resolveSeeds } from './contract'
import {
  getMediaProvidersSync,
  useMediaProviderStore,
} from '@/stores/media-provider-store'
import type {
  MediaCapabilities,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaJobState,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  NormalizedMediaRequest,
} from './contract'

/**
 * Poll delays, in order. Index N is the wait before the (N+1)th poll; past the
 * end of the list the ceiling applies. Deliberately not a `setInterval`: a slow
 * provider would otherwise have polls queue up behind each other.
 */
export const MEDIA_POLL_BACKOFF_MS = [1000, 2000, 4000, 8000]

/** The interval never grows past this, however long the job runs. */
export const MEDIA_POLL_CEILING_MS = 10_000

/**
 * Consecutive transport failures before a job is given up on. The old code had
 * no such limit, so an unreachable worker produced an infinite error loop that
 * set React state on every tick.
 */
export const MEDIA_POLL_MAX_CONSECUTIVE_FAILURES = 5

/**
 * How long a subscribed stream may say nothing before polling starts as well.
 *
 * `MediaProviderAdapter.subscribe` returns only an unsubscribe function - it
 * has no channel for reporting that the stream died. So a socket that drops
 * quietly is indistinguishable from one with nothing to report, and a watchdog
 * is the only thing standing between that and a job that never updates again.
 * The subscription is kept, not torn down: if it recovers, its events are still
 * welcome.
 */
export const MEDIA_SUBSCRIBE_SILENCE_MS = 15_000

/**
 * How many times a submit may reach the provider before the manager gives up.
 * The first attempt is attempt 0; the retries follow.
 */
export const MEDIA_SUBMIT_MAX_ATTEMPTS = 3

/**
 * Delay before the (N+1)th submit attempt, i.e. before each retry. The last
 * entry repeats past the end, so a provider with no `Retry-After` still stops
 * hammering after the backoff ceiling.
 */
export const MEDIA_SUBMIT_BACKOFF_MS = [1000, 2000]

const TERMINAL: ReadonlySet<MediaJobState> = new Set<MediaJobState>([
  'succeeded',
  'failed',
  'cancelled',
])

export const isTerminalMediaJobState = (state: MediaJobState): boolean =>
  TERMINAL.has(state)

/** A snapshot plus what the manager knows that the provider does not. */
export type MediaJobEntry = MediaJobSnapshot & {
  /** What was actually asked for. Provenance for Task 8 and for re-running. */
  request: NormalizedMediaRequest
  submitted_at: number
  /** The provider reports `features.cancel` *and* implements `cancel`. */
  cancellable: boolean
}

export type MediaJobManagerState = {
  jobs: Record<string, MediaJobEntry>
  /** Client job ids, newest first. */
  order: string[]
}

export type MediaJobManagerDeps = {
  createAdapter: (descriptor: MediaProviderDescriptor) => MediaProviderAdapter
  providers: () => MediaProviderDescriptor[]
  capabilitiesFor: (providerId: string) => MediaCapabilities | undefined
  now?: () => number
  /** Seed source. Injected so D8's resolution is testable. Like Math.random. */
  random?: () => number
  /**
   * Optional durable history. When present, jobs are written back on every
   * state change and can be restored with `load()` after a reload. `outputs`
   * is stripped before saving — the library already owns the materialised
   * files, so only state and provenance belong on disk.
   */
  persist?: {
    load: () => Promise<MediaJobEntry[]>
    save: (jobs: MediaJobEntry[]) => Promise<void>
  }
  warn?: (message: string, cause?: unknown) => void
}

export type MediaJobManager = {
  store: StoreApi<MediaJobManagerState>
  submit: (request: NormalizedMediaRequest) => Promise<MediaJobEntry>
  cancel: (clientJobId: string) => Promise<void>
  canCancel: (clientJobId: string) => boolean
  get: (clientJobId: string) => MediaJobEntry | undefined
  list: () => MediaJobEntry[]
  /** Restore jobs persisted by a previous session. Safe to call more than once. */
  load: () => Promise<void>
  /** Stop watching everything. Does not cancel work already on a provider. */
  dispose: () => void
}

/** Per-job bookkeeping. Never in the store: none of it is renderable. */
type Watch = {
  adapter: MediaProviderAdapter
  handle: MediaJobHandle
  timer?: ReturnType<typeof setTimeout>
  silence?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
  /** How many polls have been scheduled, which is the backoff index. */
  attempt: number
  /** Consecutive transport failures; reset by any successful poll. */
  failures: number
  /** Polling has started, either directly or as a stream fallback. */
  polling: boolean
  stopped: boolean
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Whether a failed submit is worth trying again.
 *
 * A provider's own error carries `retryable` (rate limits, timeouts,
 * server-side failures are; a bad key or bad request is not). An error with no
 * such signal is a transport failure — the same rule `jobErrorFrom` uses — and
 * says nothing about the job itself, so it is retried.
 */
function isRetryableSubmitError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { retryable?: unknown }
    if (typeof candidate.retryable === 'boolean') return candidate.retryable
  }
  return true
}

/** The delay before a retry: the backoff, or `Retry-After` if the provider asked for longer. */
function retryDelayFor(error: unknown, retryIndex: number): number {
  const backoff =
    MEDIA_SUBMIT_BACKOFF_MS[retryIndex] ??
    MEDIA_SUBMIT_BACKOFF_MS[MEDIA_SUBMIT_BACKOFF_MS.length - 1]!
  let requested = 0
  if (typeof error === 'object' && error !== null) {
    const retryAfter = (error as { retryAfterMs?: unknown }).retryAfterMs
    if (
      typeof retryAfter === 'number' &&
      Number.isFinite(retryAfter) &&
      retryAfter > 0
    ) {
      requested = retryAfter
    }
  }
  return Math.max(backoff, requested)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Submit with retry. A rate limit or a dropped connection is worth a second
 * (and third) attempt; a bad key or invalid request is not and is re-thrown on
 * the first failure.
 */
async function submitToAdapter(
  adapter: MediaProviderAdapter,
  request: NormalizedMediaRequest
): Promise<MediaJobSnapshot> {
  let lastError: unknown
  for (let attempt = 0; attempt < MEDIA_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await adapter.submit(request)
    } catch (error) {
      lastError = error
      if (!isRetryableSubmitError(error)) throw error
      if (attempt === MEDIA_SUBMIT_MAX_ATTEMPTS - 1) break
      const delay = retryDelayFor(error, attempt)
      if (delay > 0) await sleep(delay)
    }
  }
  throw lastError
}

export function createMediaJobManager(
  deps: MediaJobManagerDeps
): MediaJobManager {
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const store = createStore<MediaJobManagerState>(() => ({
    jobs: {},
    order: [],
  }))
  const watches = new Map<string, Watch>()
  /**
   * Ids whose submit is in flight. `client_job_id` is the contract's
   * idempotency key, but a store check alone cannot enforce it: the store is
   * not written until the adapter answers, so two clicks a few milliseconds
   * apart would both get past the check and both reach the provider.
   */
  const inFlight = new Set<string>()

  const get = (clientJobId: string): MediaJobEntry | undefined =>
    store.getState().jobs[clientJobId]

  function put(clientJobId: string, entry: MediaJobEntry) {
    store.setState((state) => ({
      jobs: { ...state.jobs, [clientJobId]: entry },
      order: state.order.includes(clientJobId)
        ? state.order
        : [clientJobId, ...state.order],
    }))
    persistNow()
  }

  /**
   * Write the current history to disk, best-effort. `outputs` is dropped: it
   * can carry inline bytes too large to re-serialise every poll, and the
   * library already owns the materialised files.
   */
  function persistNow() {
    if (!deps.persist) return
    const { jobs, order } = store.getState()
    const snapshots = order
      .map((id) => jobs[id])
      .filter((entry): entry is MediaJobEntry => entry !== undefined)
      .map((entry) => ({ ...entry, outputs: undefined }))
    void deps.persist.save(snapshots).catch((error) => {
      deps.warn?.('Could not persist media jobs.', error)
    })
  }

  function merge(clientJobId: string, snapshot: MediaJobSnapshot) {
    const existing = get(clientJobId)
    if (!existing) return
    // A terminal job is final. Even if a late frame arrives from a stream that
    // should already have been torn down, it must not resurrect the job.
    if (isTerminalMediaJobState(existing.state)) return
    put(clientJobId, { ...existing, ...snapshot })
  }

  function stopWatching(clientJobId: string) {
    const watch = watches.get(clientJobId)
    if (!watch) return
    watch.stopped = true
    if (watch.timer !== undefined) clearTimeout(watch.timer)
    if (watch.silence !== undefined) clearTimeout(watch.silence)
    try {
      watch.unsubscribe?.()
    } catch {
      // An adapter that throws while tearing down its own transport is not
      // something the caller can act on, and must not mask the job's result.
    }
    watches.delete(clientJobId)
  }

  function settle(clientJobId: string, snapshot: MediaJobSnapshot) {
    merge(clientJobId, snapshot)
    if (isTerminalMediaJobState(snapshot.state)) stopWatching(clientJobId)
  }

  function schedulePoll(clientJobId: string) {
    const watch = watches.get(clientJobId)
    if (!watch || watch.stopped) return

    watch.polling = true
    const delay = MEDIA_POLL_BACKOFF_MS[watch.attempt] ?? MEDIA_POLL_CEILING_MS
    watch.attempt += 1
    watch.timer = setTimeout(() => {
      void runPoll(clientJobId)
    }, delay)
  }

  async function runPoll(clientJobId: string) {
    const watch = watches.get(clientJobId)
    if (!watch || watch.stopped) return

    try {
      const snapshot = await watch.adapter.poll(watch.handle)
      watch.failures = 0
      if (watch.stopped) return
      settle(clientJobId, snapshot)
      if (!isTerminalMediaJobState(snapshot.state)) schedulePoll(clientJobId)
    } catch (error) {
      if (watch.stopped) return
      watch.failures += 1

      if (watch.failures >= MEDIA_POLL_MAX_CONSECUTIVE_FAILURES) {
        const existing = get(clientJobId)
        if (existing) {
          put(clientJobId, {
            ...existing,
            state: 'failed',
            error: {
              code: 'poll_failed',
              // Retryable, unlike a provider-side execution error: the job may
              // well have been fine and the transport was not. Saying otherwise
              // would tell the user to give up on something recoverable.
              message: `Lost contact with "${existing.provider_id}" after ${watch.failures} attempts: ${detailOf(error)}`,
              retryable: true,
            },
          })
        }
        stopWatching(clientJobId)
        return
      }

      schedulePoll(clientJobId)
    }
  }

  function armSilenceWatchdog(clientJobId: string) {
    const watch = watches.get(clientJobId)
    if (!watch || watch.stopped) return
    if (watch.silence !== undefined) clearTimeout(watch.silence)

    watch.silence = setTimeout(() => {
      const current = watches.get(clientJobId)
      if (!current || current.stopped || current.polling) return
      // Keep the subscription: this is a safety net, not a replacement.
      schedulePoll(clientJobId)
    }, MEDIA_SUBSCRIBE_SILENCE_MS)
  }

  function startWatching(clientJobId: string) {
    const watch = watches.get(clientJobId)
    if (!watch) return

    const providerId = get(clientJobId)?.provider_id
    const features = providerId
      ? deps.capabilitiesFor(providerId)?.features
      : undefined

    if (features?.events === true && typeof watch.adapter.subscribe === 'function') {
      try {
        watch.unsubscribe = watch.adapter.subscribe(watch.handle, (snapshot) => {
          settle(clientJobId, snapshot)
          if (!isTerminalMediaJobState(snapshot.state)) {
            armSilenceWatchdog(clientJobId)
          }
        })
        armSilenceWatchdog(clientJobId)
        return
      } catch {
        // The stream could not be opened at all. Fall through: the job is
        // already running on the provider and must not be lost with the socket.
      }
    }

    schedulePoll(clientJobId)
  }

  return {
    store,
    get,

    list: () => {
      const { jobs, order } = store.getState()
      return order
        .map((id) => jobs[id])
        .filter((entry): entry is MediaJobEntry => entry !== undefined)
    },

    canCancel: (clientJobId) => {
      const entry = get(clientJobId)
      if (!entry) return false
      return entry.cancellable && !isTerminalMediaJobState(entry.state)
    },

    async submit(request) {
      const existing = get(request.client_job_id)
      if (existing) return existing
      if (inFlight.has(request.client_job_id)) {
        throw new Error(
          `A submit for client job "${request.client_job_id}" is already in flight.`
        )
      }

      const descriptor = deps
        .providers()
        .find((provider) => provider.id === request.provider_id)
      if (!descriptor) {
        throw new Error(
          `No media provider is configured with id "${request.provider_id}".`
        )
      }

      // Decision D8: the seed is resolved HERE, above every adapter, so the app
      // knows the number it sent. Leaving it to the provider made the value
      // unrecoverable, which is what stopped provenance and "re-run" from
      // telling the truth. `resolved` - not `request` - is what gets submitted
      // AND what gets recorded, so those two can never disagree.
      const capabilities = deps.capabilitiesFor(request.provider_id)
      const specs =
        capabilities?.models.find((model) => model.id === request.model_id)
          ?.params?.[request.task] ?? []
      const resolved: NormalizedMediaRequest = specs.length
        ? { ...request, params: resolveSeeds(specs, request.params, random) }
        : request

      inFlight.add(request.client_job_id)
      try {
        const adapter = deps.createAdapter(descriptor)
        const snapshot = await submitToAdapter(adapter, resolved)
        const features = capabilities?.features

        const entry: MediaJobEntry = {
          ...snapshot,
          request: resolved,
          submitted_at: now(),
          cancellable:
            features?.cancel === true && typeof adapter.cancel === 'function',
        }
        put(request.client_job_id, entry)

        if (!isTerminalMediaJobState(entry.state)) {
          watches.set(request.client_job_id, {
            adapter,
            handle: {
              client_job_id: entry.client_job_id,
              provider_job_id: entry.provider_job_id,
            },
            attempt: 0,
            failures: 0,
            polling: false,
            stopped: false,
          })
          startWatching(request.client_job_id)
        }

        return entry
      } finally {
        inFlight.delete(request.client_job_id)
      }
    },

    async load() {
      if (!deps.persist) return
      const persisted = await deps.persist.load()
      const state = store.getState()
      const jobs = { ...state.jobs }
      const order = [...state.order]

      for (const entry of persisted) {
        if (jobs[entry.client_job_id]) continue
        // A terminal job is restored as the history it is. A job that was
        // still queued or running when the app closed lost its watcher and its
        // backoff/subscription state, so it cannot be polled to completion.
        // The honest answer is "interrupted", retryable so a re-run is offered.
        const restored: MediaJobEntry = isTerminalMediaJobState(entry.state)
          ? entry
          : {
              ...entry,
              state: 'failed',
              error: {
                code: 'interrupted',
                message: 'The app closed while this job was still running.',
                retryable: true,
              },
            }
        jobs[entry.client_job_id] = restored
        order.push(entry.client_job_id)
      }

      store.setState({ jobs, order })
    },

    async cancel(clientJobId) {
      const entry = get(clientJobId)
      if (!entry) {
        throw new Error(`No media job is known for "${clientJobId}".`)
      }
      if (isTerminalMediaJobState(entry.state)) return

      const watch = watches.get(clientJobId)
      if (!entry.cancellable || !watch?.adapter.cancel) {
        // C11 again: the honest answer is a refusal, not a quiet no-op that
        // leaves the provider working while the UI claims otherwise.
        throw new Error(
          `Provider "${entry.provider_id}" cannot cancel a job once it has started.`
        )
      }

      await watch.adapter.cancel(watch.handle)
      stopWatching(clientJobId)
      const current = get(clientJobId)
      if (current) put(clientJobId, { ...current, state: 'cancelled' })
    },

    dispose() {
      for (const clientJobId of [...watches.keys()]) stopWatching(clientJobId)
    },
  }
}

/**
 * The app-wide instance. Module-scoped on purpose: it must outlive every route
 * and every component that looks at it.
 *
 * Persistence is wired lazily: the real filesystem and data-folder bindings
 * live in `@/stores/media-library-store`, which touches the `@janhq/core`
 * bridge. That module must not be pulled into the graph of code that only
 * wants the manager (and must not be loaded by the test environment), so it is
 * imported on first use instead of at module evaluation.
 */
type MediaJobsStoreInstance = ReturnType<typeof createMediaJobsStore>

let jobsStorePromise: Promise<MediaJobsStoreInstance> | undefined

function mediaJobsStore(): Promise<MediaJobsStoreInstance> {
  if (!jobsStorePromise) {
    jobsStorePromise = (async () => {
      const { coreMediaFileSystem, mediaDataFolder } = await import(
        '@/stores/media-library-store'
      )
      return createMediaJobsStore({
        fs: coreMediaFileSystem,
        dataFolder: mediaDataFolder,
        warn: (message, cause) =>
          console.warn(`[media-jobs] ${message}`, cause),
      })
    })()
  }
  return jobsStorePromise
}

export const mediaJobManager = createMediaJobManager({
  createAdapter: createMediaAdapter,
  providers: getMediaProvidersSync,
  capabilitiesFor: (providerId) =>
    useMediaProviderStore.getState().capabilities[providerId],
  persist: {
    async load() {
      return (await mediaJobsStore()).load()
    },
    async save(jobs) {
      await (await mediaJobsStore()).save(jobs)
    },
  },
})
