/**
 * Runs a continuous session: steps execute one after another through the
 * shared media job manager, with no user interaction between them. Each step's
 * init image is the last frame of the previous finished clip (or the user's
 * image). Finished clips are written to the library as they complete, so
 * pausing, cancelling, a failure or a crash never loses them. Optionally all
 * clips are stitched into one file at the end; the individual clips are kept.
 */
import {
  finishedClips,
  initSourceFor,
  nextStepIndex,
  resumableSteps,
  type ContinuousSession,
  type ContinuousStep,
} from './session'

export type StepResult = { asset_id: string; path: string; mime: string }

export type SessionRunnerDeps = {
  /** Submit one generation and resolve when its clip is in the library. */
  runStep: (
    step: ContinuousStep,
    initImage: string | undefined,
    session: ContinuousSession,
    signal: AbortSignal
  ) => Promise<StepResult>
  extractLastFrame: (path: string, mime: string) => Promise<string>
  /** Concatenate clips; undefined when stitching is unavailable (no ffmpeg). */
  stitch?: (paths: string[], session: ContinuousSession) => Promise<string>
  save: (session: ContinuousSession) => Promise<void>
  now: () => number
  warn?: (message: string, cause?: unknown) => void
}

export type RunControl = {
  /** Finish the current step, then stop. */
  pause: () => void
  /** Abort the current step too. Finished clips stay. */
  cancel: () => void
  done: Promise<ContinuousSession>
}

export function runSession(
  initial: ContinuousSession,
  deps: SessionRunnerDeps,
  onChange: (session: ContinuousSession) => void = () => {}
): RunControl {
  let session: ContinuousSession = {
    ...initial,
    steps: resumableSteps(initial.steps),
    status: 'running',
    error: undefined,
  }
  let paused = false
  const abort = new AbortController()

  const commit = async (patch: Partial<ContinuousSession>) => {
    session = { ...session, ...patch, updated_at: deps.now() }
    onChange(session)
    try {
      await deps.save(session)
    } catch (error) {
      deps.warn?.('Could not save the session', error)
    }
  }
  const setStep = (index: number, patch: Partial<ContinuousStep>) =>
    commit({ steps: session.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) })

  const done = (async () => {
    await commit({})
    for (;;) {
      if (abort.signal.aborted) {
        await commit({ status: 'cancelled' })
        return session
      }
      if (paused) {
        await commit({ status: 'paused' })
        return session
      }
      const index = nextStepIndex(session.steps)
      if (index < 0) break
      await setStep(index, { status: 'running' })
      try {
        const source = initSourceFor(session.steps, index)
        let initImage: string | undefined
        if (source.kind === 'image') initImage = source.image
        else if (source.kind === 'clip') initImage = await deps.extractLastFrame(source.path, source.mime)
        const result = await deps.runStep(session.steps[index]!, initImage, session, abort.signal)
        await setStep(index, { status: 'succeeded', ...result })
      } catch (error) {
        const cancelled = abort.signal.aborted
        await setStep(index, {
          status: cancelled ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        if (cancelled) {
          await commit({ status: 'cancelled' })
        } else {
          await commit({ status: 'failed', error: `Run ${index + 1} failed; finished clips were kept.` })
        }
        return session
      }
    }
    const clips = finishedClips(session.steps)
    if (session.stitch && clips.length > 1) {
      if (!deps.stitch) {
        await commit({ status: 'succeeded', error: 'Clips kept separately: ffmpeg was not found for stitching.' })
        return session
      }
      try {
        const stitched_path = await deps.stitch(clips, session)
        await commit({ status: 'succeeded', stitched_path })
        return session
      } catch (error) {
        await commit({
          status: 'succeeded',
          error: `Stitching failed (${error instanceof Error ? error.message : String(error)}); individual clips were kept.`,
        })
        return session
      }
    }
    await commit({ status: 'succeeded' })
    return session
  })()

  return {
    pause: () => {
      paused = true
    },
    cancel: () => abort.abort(),
    done,
  }
}
