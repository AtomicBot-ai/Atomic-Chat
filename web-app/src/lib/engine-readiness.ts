import { invoke } from '@tauri-apps/api/core'
import type { SessionInfo } from '@janhq/core'
import { useModelProvider } from '@/hooks/useModelProvider'
import { findLocalSession, ModelFactory } from '@/lib/model-factory'
import { RECOVERABLE_LOCAL_PROVIDERS } from '@/lib/turn-recovery'
import type { ServiceHub } from '@/services'

/**
 * Waits until a local model's engine answers again, starting it when it is
 * not running.
 *
 * The chat transport only waits for an engine indirectly: when the core's
 * session table (mirrored in Rust) has no session for the model, the
 * transport's `startModel` loads one and waits for it. A session the mirror
 * still lists after its process died is dialled straight away and refused —
 * the mirror has no health check. So this asks the server itself, on
 * `/health`, and treats a session that keeps refusing as stale: unloaded and
 * loaded again through the same `startModel` the transport uses.
 */

export type EngineHealth = 'ready' | 'loading' | 'unreachable'

export type EngineReadiness =
  | { ok: true; port: number; restarted: boolean }
  | {
      ok: false
      reason:
        | 'aborted'
        | 'timeout'
        | 'start_failed'
        | 'no_provider'
        | 'unsupported'
      error?: string
    }

/** Seconds one `/health` probe may take. */
const HEALTH_PROBE_TIMEOUT_SECS = 3
/** How long the whole wait may take; a cold load of a large model on Windows is slow. */
export const ENGINE_READY_TIMEOUT_MS = 120_000
const ENGINE_READY_POLL_MS = 500
/**
 * Refused probes in a row before a listed session counts as stale. A dead
 * process usually leaves the mirror within a probe or two; this gives the
 * core that chance before the app unloads the session itself.
 */
const STALE_PROBES_BEFORE_RESTART = 3

/**
 * One `/health` probe of a session, on 127.0.0.1. llama-server and mlx-vlm
 * answer 200 once the model is loaded and llama-server 503 while it is still
 * loading; any other HTTP answer still means something is listening.
 */
export async function probeEngineHealth(
  session: Pick<SessionInfo, 'port' | 'api_key'>,
  timeoutSecs = HEALTH_PROBE_TIMEOUT_SECS
): Promise<EngineHealth> {
  try {
    await invoke<string>('get_local_http', {
      url: `http://127.0.0.1:${session.port}/health`,
      headers: session.api_key
        ? { Authorization: `Bearer ${session.api_key}` }
        : {},
      timeoutSecs,
    })
    return 'ready'
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const status = /^HTTP (\d{3})\b/.exec(text)?.[1]
    if (status === '503') return 'loading'
    return status ? 'ready' : 'unreachable'
  }
}

export type EngineReadinessDeps = {
  findSession: (
    providerId: string,
    modelId: string
  ) => Promise<SessionInfo | null>
  probe: (session: SessionInfo) => Promise<EngineHealth>
  start: (providerId: string, modelId: string) => Promise<void>
  stop: (providerId: string, modelId: string) => Promise<void>
  /** Forget the transport's cached session so the next request resolves a fresh one. */
  invalidate: (providerId: string, modelId: string) => void
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
}

class NoProviderError extends Error {}

function defaultDeps(serviceHub: ServiceHub): EngineReadinessDeps {
  return {
    findSession: (providerId, modelId) =>
      findLocalSession(
        providerId as Parameters<typeof findLocalSession>[0],
        modelId
      ),
    probe: (session) => probeEngineHealth(session),
    start: async (providerId, modelId) => {
      const provider = useModelProvider.getState().getProviderByName(providerId)
      if (!provider) throw new NoProviderError(providerId)
      await serviceHub.models().startModel(provider, modelId)
    },
    stop: async (providerId, modelId) => {
      await serviceHub.models().stopModel(modelId, providerId)
    },
    invalidate: (providerId, modelId) =>
      ModelFactory.invalidateLocalSessionCache(providerId, modelId),
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      }),
    now: () => Date.now(),
  }
}

class DeadlineError extends Error {}
class AbortedError extends Error {}

/** `work`, or a rejection once `ms` pass or `signal` aborts; `work` itself goes on. */
function withinDeadline<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A stop that came while `work` was being started has already fired.
    if (signal?.aborted) return reject(new AbortedError())
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = () => settle(() => reject(new AbortedError()))
    const timer = setTimeout(
      () => settle(() => reject(new DeadlineError())),
      Math.max(0, ms)
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    )
  })
}

/**
 * Resolves once `modelId` on `providerId` answers `/health`, starting (or,
 * when its session is stale, restarting) it at most once. Never throws.
 */
export async function waitForEngineReady(
  args: {
    providerId: string
    modelId: string
    serviceHub: ServiceHub
    signal?: AbortSignal
    timeoutMs?: number
    pollMs?: number
  },
  overrides: Partial<EngineReadinessDeps> = {}
): Promise<EngineReadiness> {
  const { providerId, modelId, signal } = args
  if (!RECOVERABLE_LOCAL_PROVIDERS.has(providerId)) {
    return { ok: false, reason: 'unsupported' }
  }
  const deps = { ...defaultDeps(args.serviceHub), ...overrides }
  const pollMs = args.pollMs ?? ENGINE_READY_POLL_MS
  const deadline = deps.now() + (args.timeoutMs ?? ENGINE_READY_TIMEOUT_MS)

  let restarted = false
  let staleProbes = 0

  const startOnce = async (
    unloadFirst: boolean
  ): Promise<EngineReadiness | undefined> => {
    restarted = true
    if (unloadFirst) {
      await deps.stop(providerId, modelId).catch((error) => {
        console.warn(
          `[engine-readiness] unloading stale ${modelId} failed:`,
          error
        )
      })
    }
    deps.invalidate(providerId, modelId)
    try {
      await withinDeadline(
        deps.start(providerId, modelId),
        deadline - deps.now(),
        signal
      )
      return undefined
    } catch (error) {
      if (error instanceof AbortedError) return { ok: false, reason: 'aborted' }
      if (error instanceof DeadlineError)
        return { ok: false, reason: 'timeout' }
      if (error instanceof NoProviderError)
        return { ok: false, reason: 'no_provider' }
      return {
        ok: false,
        reason: 'start_failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  deps.invalidate(providerId, modelId)
  for (;;) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    if (deps.now() >= deadline) return { ok: false, reason: 'timeout' }

    const session = await deps
      .findSession(providerId, modelId)
      .catch(() => null)
    if (!session) {
      if (!restarted) {
        const failed = await startOnce(false)
        if (failed) return failed
        continue
      }
    } else {
      const health = await deps.probe(session)
      if (health === 'ready') {
        deps.invalidate(providerId, modelId)
        return { ok: true, port: session.port, restarted }
      }
      if (health === 'unreachable') {
        staleProbes += 1
        if (!restarted && staleProbes >= STALE_PROBES_BEFORE_RESTART) {
          const failed = await startOnce(true)
          if (failed) return failed
          staleProbes = 0
          continue
        }
      } else {
        staleProbes = 0
      }
    }
    await deps.sleep(pollMs, signal)
  }
}
