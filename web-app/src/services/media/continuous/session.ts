/**
 * Continuous video sessions: several clips chained into one longer movie.
 *
 * A session is an ordered list of segments. Each segment runs `runs` times;
 * every run starts from the last frame of the previous run's output (or from
 * an image the user picked), so the clips continue each other. Everything in
 * this module is pure so the sequencing and prompt-inheritance rules can be
 * tested without a GPU, a filesystem or React.
 *
 * Resolution is deliberately NOT handled here: a segment's `params` are passed
 * through untouched, and the request is built by `resolveChatRequest`, so the
 * separate resolution work owns that logic alone.
 */

export type SegmentStartSource =
  /** Last frame of the previous run's output. The first run falls back to text-only. */
  | { kind: 'previous' }
  /** A user-chosen image (data URL or file path the caller can read). */
  | { kind: 'image'; image: string; name?: string }
  /** Text-to-video with no init image. */
  | { kind: 'none' }

export type ContinuousSegment = {
  id: string
  /** Blank inherits the previous segment's effective prompt. */
  prompt: string
  start: SegmentStartSource
  /** How many consecutive runs of this segment. >= 1. */
  runs: number
  /** Clip length in seconds, or undefined for the model default. */
  length_seconds?: number
  fps?: number
  /** Advanced overrides merged over the base request params (seed, steps, ...). */
  params?: Record<string, unknown>
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type ContinuousStep = {
  /** Index into `segments`. */
  segment: number
  /** 0-based run number within the segment. */
  run: number
  prompt: string
  start: SegmentStartSource
  length_seconds?: number
  fps?: number
  params: Record<string, unknown>
  status: StepStatus
  /** Library asset of the finished clip. */
  asset_id?: string
  /** On-disk path of the finished clip. */
  path?: string
  mime?: string
  error?: string
}

export type SessionStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type ContinuousSession = {
  id: string
  name: string
  created_at: number
  updated_at: number
  /** The overall story, as given to the planner. */
  story?: string
  segments: ContinuousSegment[]
  steps: ContinuousStep[]
  status: SessionStatus
  /** Stitch all finished clips into one file at the end (needs ffmpeg). */
  stitch: boolean
  stitched_path?: string
  /** Shared params for every step (negative prompt, steps, cfg ...). */
  base_params?: Record<string, unknown>
  error?: string
}

/**
 * The effective prompt of every segment: a blank prompt inherits the previous
 * segment's effective prompt. A leading blank stays blank (the caller rejects
 * a session that has no prompt at all).
 */
export function effectivePrompts(segments: Pick<ContinuousSegment, 'prompt'>[]): string[] {
  const out: string[] = []
  let previous = ''
  for (const segment of segments) {
    const own = segment.prompt.trim()
    const effective = own.length > 0 ? own : previous
    out.push(effective)
    previous = effective
  }
  return out
}

export function clampRuns(runs: number): number {
  if (!Number.isFinite(runs)) return 1
  return Math.max(1, Math.min(100, Math.floor(runs)))
}

/** Problems that make a session impossible to run, or `[]`. */
export function validateSegments(segments: ContinuousSegment[]): string[] {
  const problems: string[] = []
  if (segments.length === 0) problems.push('Add at least one segment.')
  const prompts = effectivePrompts(segments)
  prompts.forEach((prompt, index) => {
    if (!prompt) problems.push(`Segment ${index + 1} has no prompt and nothing to inherit.`)
  })
  segments.forEach((segment, index) => {
    if (segment.start.kind === 'image' && !segment.start.image) {
      problems.push(`Segment ${index + 1} needs a start image.`)
    }
  })
  return problems
}

/**
 * Expand segments into the ordered runs the queue executes. Each segment
 * contributes `runs` consecutive steps. Runs after the first in a segment with
 * a user image continue from the previous clip, so a segment reads as one
 * continuous shot rather than N restarts from the same picture.
 */
export function expandSteps(segments: ContinuousSegment[]): ContinuousStep[] {
  const prompts = effectivePrompts(segments)
  const steps: ContinuousStep[] = []
  segments.forEach((segment, index) => {
    const runs = clampRuns(segment.runs)
    for (let run = 0; run < runs; run++) {
      steps.push({
        segment: index,
        run,
        prompt: prompts[index] ?? '',
        start: run === 0 ? segment.start : { kind: 'previous' },
        ...(segment.length_seconds !== undefined ? { length_seconds: segment.length_seconds } : {}),
        ...(segment.fps !== undefined ? { fps: segment.fps } : {}),
        params: { ...(segment.params ?? {}) },
        status: 'pending',
      })
    }
  })
  return steps
}

/** Index of the next step to run, or -1 when none is left. */
export function nextStepIndex(steps: ContinuousStep[]): number {
  return steps.findIndex((step) => step.status === 'pending')
}

/**
 * The init image source for step `index`: the user's image, the previous
 * finished clip's path (the caller extracts its last frame), or nothing.
 */
export function initSourceFor(
  steps: ContinuousStep[],
  index: number
): { kind: 'image'; image: string } | { kind: 'clip'; path: string; mime: string } | { kind: 'none' } {
  const step = steps[index]
  if (!step) return { kind: 'none' }
  if (step.start.kind === 'image') return { kind: 'image', image: step.start.image }
  if (step.start.kind === 'none') return { kind: 'none' }
  for (let i = index - 1; i >= 0; i--) {
    const prior = steps[i]!
    if (prior.status === 'succeeded' && prior.path) {
      return { kind: 'clip', path: prior.path, mime: prior.mime ?? 'video/mp4' }
    }
  }
  return { kind: 'none' }
}

/** Finished clip paths in order. Pausing/cancelling never removes these. */
export function finishedClips(steps: ContinuousStep[]): string[] {
  return steps
    .filter((step) => step.status === 'succeeded' && step.path)
    .map((step) => step.path!)
}

/** Per-segment roll-up for the progress UI. */
export function segmentProgress(
  session: Pick<ContinuousSession, 'segments' | 'steps'>
): { segment: number; done: number; total: number; status: StepStatus }[] {
  return session.segments.map((_, segment) => {
    const steps = session.steps.filter((step) => step.segment === segment)
    const done = steps.filter((step) => step.status === 'succeeded').length
    let status: StepStatus = 'pending'
    if (steps.some((s) => s.status === 'running')) status = 'running'
    else if (steps.some((s) => s.status === 'failed')) status = 'failed'
    else if (steps.length > 0 && done === steps.length) status = 'succeeded'
    else if (steps.some((s) => s.status === 'cancelled')) status = 'cancelled'
    return { segment, done, total: steps.length, status }
  })
}

/** Reset steps a crash or pause left as `running`/`cancelled` so resume can pick them up. */
export function resumableSteps(steps: ContinuousStep[]): ContinuousStep[] {
  return steps.map((step) =>
    step.status === 'running' || step.status === 'cancelled' || step.status === 'failed'
      ? { ...step, status: 'pending' as const, error: undefined }
      : step
  )
}
