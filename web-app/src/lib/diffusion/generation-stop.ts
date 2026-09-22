/**
 * The two decisions the multi-run loop makes after every job.
 *
 * Kept out of the store so they can be tested as a table: which combinations
 * of "the user pressed Stop", "the job ended how" and "how many runs are left"
 * continue, and which failures are worth a toast.
 */

import type { ImageJobState, NativeDiffusionErrorCode } from '@/services/diffusion/types'

export type ContinueInput = {
  /** The user pressed Stop at some point during this batch of runs. */
  stopRequested: boolean
  /** How the run that just ended finished. */
  jobState: ImageJobState
  /** 0-based index of the run that just ended. */
  run: number
  runsTotal: number
}

/**
 * Whether the loop should start the next run.
 *
 * Only a completed run that was not interrupted and is not the last one goes
 * on. A failure stops the loop — the same request would fail again — and a
 * cancellation is the user saying stop, whether or not `stopRequested` made
 * it into the store before the job reported back.
 */
export function shouldContinueGenerating(input: ContinueInput): boolean {
  if (input.stopRequested) return false
  if (input.jobState !== 'completed') return false
  return input.run + 1 < input.runsTotal
}

export type ReportInput = {
  code: NativeDiffusionErrorCode | null | undefined
  stopRequested: boolean
}

/**
 * Whether a failed or cancelled job deserves an error toast.
 *
 * A `CANCELLED` job after the user pressed Stop is the outcome they asked
 * for; toasting it would read as a failure. A `CANCELLED` job the user did
 * *not* ask for (the idle timer, the process reaper, a crash reported as a
 * cancel) is still worth surfacing.
 */
export function shouldReportGenerateError(input: ReportInput): boolean {
  if (!input.code) return false
  if (input.code === 'CANCELLED' && input.stopRequested) return false
  return true
}
