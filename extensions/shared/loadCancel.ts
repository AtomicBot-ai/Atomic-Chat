/**
 * Cancelling a model load that runs in the core (ATO-530), shared by the runtime extensions.
 *
 * The core registers a load the moment its request arrives and answers `POST …/load/cancel` with
 * whether one was pending. Two windows are the extension's to cover: the request that is still on
 * its way to the core (the cancel is retried for as long as that request is outstanding), and a
 * load that already answered by the time the cancel lands (the session is unloaded again and the
 * load rejects all the same). Either way `load` rejects with `MODEL_LOAD_CANCELLED`, which the
 * web app treats as the user's choice, not a failure.
 */

import { describeCoreError, isCoreError } from './atomicCoreRuntime'

/** Matches the core's `MODEL_LOAD_CANCELLED` and `@janhq/core`'s `MODEL_LOAD_CANCELLED_CODE`. */
export const MODEL_LOAD_CANCELLED = 'MODEL_LOAD_CANCELLED'
/** How soon a cancel asks the core again while the load it chases has not arrived there yet. */
export const CANCEL_RETRY_INTERVAL_MS = 50

export type CodedError = Error & { code: string; details?: string }

/** An `Error` carrying a `code` own-property, so callers branch on the cause, not the text. */
export function codedError(code: string, message: string, details?: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

export function loadCancelledError(): CodedError {
  return codedError(MODEL_LOAD_CANCELLED, 'The model load was cancelled.')
}

/**
 * A rejection from the core as the web app expects a load failure: an `Error` whose message reads
 * like the core's one-liner and whose `code` is the core's, so `MODEL_LOAD_CANCELLED`,
 * `MODEL_FILE_NOT_FOUND` and friends survive the trip. Anything else is passed through.
 */
export function toLoadError(error: unknown): unknown {
  if (error instanceof Error) return error
  if (!isCoreError(error)) return error
  const message = error.details
    ? `${error.message} (${error.details}) [${error.code}]`
    : `${error.message} [${error.code}]`
  return codedError(error.code, message, error.details)
}

export interface LoadCancelCore {
  cancelLoad(modelId: string): Promise<boolean>
  unload(modelId: string): Promise<unknown>
}

export class LoadCancelTracker {
  /** `load` calls still running per model, including ones that have not reached the core yet. */
  private readonly loadRequests = new Map<string, number>()
  /** Models whose running load the user cancelled; cleared once no load of the model is left. */
  private readonly cancelledLoads = new Set<string>()
  /**
   * Core load requests outstanding per model: only while one is can the core's cancel reach it.
   * Counted, not flagged: two loads of a model can overlap, and the first to settle must not
   * hide the one still queued in the core from a cancel.
   */
  private readonly coreLoadsInFlight = new Map<string, number>()

  constructor(
    private readonly core: LoadCancelCore,
    private readonly warn: (message: string) => void = () => {},
    private readonly retryIntervalMs = CANCEL_RETRY_INTERVAL_MS
  ) {}

  /** Whether a load of `modelId` is running. */
  isLoading(modelId: string): boolean {
    return this.loadRequests.has(modelId)
  }

  /** Wrap one whole `load` call, so a cancel can find it. */
  async track<T>(modelId: string, run: () => Promise<T>): Promise<T> {
    this.loadRequests.set(modelId, (this.loadRequests.get(modelId) ?? 0) + 1)
    try {
      return await run()
    } finally {
      const remaining = (this.loadRequests.get(modelId) ?? 1) - 1
      if (remaining > 0) this.loadRequests.set(modelId, remaining)
      else {
        this.loadRequests.delete(modelId)
        this.cancelledLoads.delete(modelId)
      }
    }
  }

  /** A checkpoint between the steps of a load. */
  throwIfCancelled(modelId: string): void {
    if (this.cancelledLoads.has(modelId)) throw loadCancelledError()
  }

  /**
   * Run the core load request itself: refuses to start after a cancel, marks the request as
   * outstanding while it runs, and takes down a session that came up before the cancel got there.
   */
  async loadInCore<T>(modelId: string, start: () => Promise<T>): Promise<T> {
    this.throwIfCancelled(modelId)
    this.coreLoadsInFlight.set(modelId, (this.coreLoadsInFlight.get(modelId) ?? 0) + 1)
    let session: T
    try {
      session = await start()
    } finally {
      const remaining = (this.coreLoadsInFlight.get(modelId) ?? 1) - 1
      if (remaining > 0) this.coreLoadsInFlight.set(modelId, remaining)
      else this.coreLoadsInFlight.delete(modelId)
    }
    if (this.cancelledLoads.has(modelId)) {
      await this.core.unload(modelId).catch((error: unknown) => {
        this.warn(`Failed to stop "${modelId}" after its load was cancelled: ${describeCoreError(error)}`)
      })
      this.throwIfCancelled(modelId)
    }
    return session
  }

  /**
   * Stop a load of `modelId` that has not finished. `true` when one was running; that load then
   * rejects with `MODEL_LOAD_CANCELLED` and leaves nothing running.
   */
  async cancelLoad(modelId: string): Promise<boolean> {
    if (!this.loadRequests.has(modelId)) return false
    this.cancelledLoads.add(modelId)
    // A miss means the request has not arrived in the core yet: ask again for as long as it is
    // outstanding. A cancel that fails outright will keep failing; the session is then taken down
    // when the load answers instead.
    while (this.coreLoadsInFlight.has(modelId)) {
      let reached: boolean
      try {
        reached = await this.core.cancelLoad(modelId)
      } catch (error) {
        this.warn(`cancelling the load of "${modelId}" failed: ${describeCoreError(error)}`)
        break
      }
      if (reached) break
      await new Promise((resolve) => setTimeout(resolve, this.retryIntervalMs))
    }
    return true
  }
}
