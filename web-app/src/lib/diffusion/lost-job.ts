/**
 * What happened to a local job the core stopped answering about.
 *
 * The app can re-attach to the same core (a heartbeat timed out while the
 * machine swapped) or to a new one (the core was stopped and started again).
 * The first keeps every job running; the second has lost them, and the page
 * must say that the engine stopped under the job — on a small machine almost
 * always for memory — rather than that a job vanished (QA 2026-10-23, ADR
 * 2026-10-26-keep-a-slow-core-that-is-still-alive-attached). Each local job
 * remembers the core instance it was submitted to; a provider's job is not
 * tied to one (the next core polls it again), so it is never tracked here.
 */

import type { DiffusionError } from '@/services/diffusion/types'

export const ENGINE_STOPPED_MESSAGE =
  'The media engine stopped before the job finished; the computer most likely ran out of memory.'

export const JOB_NOT_FOUND_MESSAGE = 'The job disappeared before it finished.'

/** Whether a job submitted to `jobInstance` can no longer finish because `current` replaced it. */
export function coreReplaced(
  jobInstance: string | null | undefined,
  current: string | null | undefined
): boolean {
  return Boolean(jobInstance && current && jobInstance !== current)
}

/** The error of a job the core says it does not know. */
export function lostJobError(
  jobInstance: string | null | undefined,
  current: string | null | undefined
): DiffusionError {
  return coreReplaced(jobInstance, current)
    ? { code: 'ENGINE_STOPPED', message: ENGINE_STOPPED_MESSAGE }
    : { code: 'JOB_NOT_FOUND', message: JOB_NOT_FOUND_MESSAGE }
}

/**
 * A failure asking about a job that means no core will come back to finish
 * it: the app has stopped restarting the core (`CORE_START_FAILED`).
 */
export function noCoreWillReturn(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'CORE_START_FAILED'
  )
}

/** The core instance a page last heard of, and the one each of its local jobs was submitted to. */
export class CoreInstanceTracker {
  private instance: string | null = null
  private readonly jobs = new Map<string, string>()

  /** The instance a `reset` event or a fresh read names; nothing is forgotten for a null. */
  note(instanceId: string | null | undefined): void {
    if (instanceId) this.instance = instanceId
  }

  get current(): string | null {
    return this.instance
  }

  /** Tie a local job to the instance it was submitted to, when that is known. */
  track(jobId: string): void {
    if (this.instance) this.jobs.set(jobId, this.instance)
  }

  forget(jobId: string): void {
    this.jobs.delete(jobId)
  }

  instanceOf(jobId: string): string | null {
    return this.jobs.get(jobId) ?? null
  }

  /** Whether `jobId` is a tracked local job whose core has been replaced. */
  replaced(jobId: string): boolean {
    return coreReplaced(this.instanceOf(jobId), this.instance)
  }

  clear(): void {
    this.instance = null
    this.jobs.clear()
  }
}
