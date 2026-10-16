import { describe, expect, it, vi } from 'vitest'
import { runSession, type SessionRunnerDeps } from '../runner'
import { expandSteps, type ContinuousSession } from '../session'

function session(runs: number[], stitch = false): ContinuousSession {
  const segments = runs.map((r, i) => ({ id: String(i), prompt: i === 0 ? 'start' : '', start: { kind: 'previous' as const }, runs: r }))
  return { id: 'S', name: 'n', created_at: 0, updated_at: 0, segments, steps: expandSteps(segments), status: 'draft', stitch }
}

function deps(overrides: Partial<SessionRunnerDeps> = {}): SessionRunnerDeps & { inits: (string | undefined)[] } {
  const inits: (string | undefined)[] = []
  let n = 0
  return {
    inits,
    now: () => 1,
    save: async () => {},
    extractLastFrame: async (path) => `frame-of-${path}`,
    runStep: async (_step, init) => {
      inits.push(init)
      n++
      return { asset_id: `a${n}`, path: `/clip${n}.mp4`, mime: 'video/mp4' }
    },
    ...overrides,
  }
}

describe('runSession', () => {
  it('runs every step in order, chaining each last frame into the next run', async () => {
    const d = deps()
    const result = await runSession(session([2, 1]), d).done
    expect(result.status).toBe('succeeded')
    expect(d.inits).toEqual([undefined, 'frame-of-/clip1.mp4', 'frame-of-/clip2.mp4'])
    expect(result.steps.every((s) => s.status === 'succeeded')).toBe(true)
  })
  it('stitches at the end and keeps the clips', async () => {
    const stitch = vi.fn().mockResolvedValue('/out.mp4')
    const result = await runSession(session([3], true), deps({ stitch })).done
    expect(stitch).toHaveBeenCalledWith(['/clip1.mp4', '/clip2.mp4', '/clip3.mp4'], expect.anything())
    expect(result.stitched_path).toBe('/out.mp4')
  })
  it('a stitch failure still succeeds with clips kept', async () => {
    const result = await runSession(session([2], true), deps({ stitch: () => Promise.reject(new Error('boom')) })).done
    expect(result.status).toBe('succeeded')
    expect(result.error).toMatch(/individual clips were kept/)
  })
  it('pause finishes the current run, keeps finished clips and can resume', async () => {
    let control!: ReturnType<typeof runSession>
    const d = deps()
    const inner = d.runStep
    d.runStep = async (...args) => {
      const r = await inner(...args)
      control.pause()
      return r
    }
    control = runSession(session([3]), d)
    const paused = await control.done
    expect(paused.status).toBe('paused')
    expect(paused.steps.map((s) => s.status)).toEqual(['succeeded', 'pending', 'pending'])
    const resumed = await runSession(paused, deps()).done
    expect(resumed.status).toBe('succeeded')
    expect(resumed.steps[0]!.path).toBe('/clip1.mp4')
  })
  it('cancel aborts the in-flight run and keeps finished clips', async () => {
    let control!: ReturnType<typeof runSession>
    let calls = 0
    const d = deps({
      runStep: (_s, _i, _x, signal) => {
        calls++
        if (calls === 1) return Promise.resolve({ asset_id: 'a', path: '/c1.mp4', mime: 'video/mp4' })
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
          control.cancel()
        })
      },
    })
    control = runSession(session([3]), d)
    const result = await control.done
    expect(result.status).toBe('cancelled')
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'cancelled', 'pending'])
  })
  it('a failed run stops the session but keeps finished clips', async () => {
    let calls = 0
    const result = await runSession(session([3]), deps({
      runStep: async () => {
        if (++calls === 2) throw new Error('OOM')
        return { asset_id: 'a', path: '/c.mp4', mime: 'video/mp4' }
      },
    })).done
    expect(result.status).toBe('failed')
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'pending'])
  })
})
