import { describe, expect, it } from 'vitest'
import {
  effectivePrompts,
  expandSteps,
  finishedClips,
  initSourceFor,
  nextStepIndex,
  resumableSteps,
  segmentProgress,
  validateSegments,
  type ContinuousSegment,
} from '../session'

const seg = (prompt: string, extra: Partial<ContinuousSegment> = {}): ContinuousSegment => ({
  id: prompt || 'blank',
  prompt,
  start: { kind: 'previous' },
  runs: 1,
  ...extra,
})

describe('prompt inheritance', () => {
  it('blank prompts inherit the previous effective prompt, transitively', () => {
    expect(effectivePrompts([seg('a'), seg(''), seg('  '), seg('b'), seg('')])).toEqual(['a', 'a', 'a', 'b', 'b'])
  })
  it('a leading blank has nothing to inherit and fails validation', () => {
    expect(validateSegments([seg(''), seg('b')])[0]).toMatch(/Segment 1/)
    expect(validateSegments([seg('a'), seg('')])).toEqual([])
    expect(validateSegments([])).not.toEqual([])
  })
  it('requires an image when the start source is a chosen image', () => {
    expect(validateSegments([seg('a', { start: { kind: 'image', image: '' } })])).toHaveLength(1)
  })
})

describe('segment sequencing', () => {
  it('expands runs consecutively, in segment order', () => {
    const steps = expandSteps([seg('a', { runs: 2 }), seg('', { runs: 3 })])
    expect(steps.map((s) => [s.segment, s.run, s.prompt])).toEqual([
      [0, 0, 'a'], [0, 1, 'a'], [1, 0, 'a'], [1, 1, 'a'], [1, 2, 'a'],
    ])
    expect(steps.every((s) => s.status === 'pending')).toBe(true)
  })
  it('only the first run of a segment uses a chosen image; later runs continue', () => {
    const steps = expandSteps([seg('a', { runs: 2, start: { kind: 'image', image: 'data:x' } })])
    expect(steps[0]!.start.kind).toBe('image')
    expect(steps[1]!.start.kind).toBe('previous')
  })
  it('clamps silly run counts', () => {
    expect(expandSteps([seg('a', { runs: 0 })])).toHaveLength(1)
    expect(expandSteps([seg('a', { runs: 1e9 })])).toHaveLength(100)
  })
  it('init source is the last finished clip, the chosen image, or none', () => {
    const steps = expandSteps([seg('a', { runs: 2 }), seg('b', { start: { kind: 'image', image: 'img' } }), seg('c', { start: { kind: 'none' } })])
    expect(initSourceFor(steps, 0)).toEqual({ kind: 'none' })
    steps[0] = { ...steps[0]!, status: 'succeeded', path: '/c0.mp4', mime: 'video/mp4' }
    expect(initSourceFor(steps, 1)).toEqual({ kind: 'clip', path: '/c0.mp4', mime: 'video/mp4' })
    expect(initSourceFor(steps, 2)).toEqual({ kind: 'image', image: 'img' })
    expect(initSourceFor(steps, 3)).toEqual({ kind: 'none' })
    expect(nextStepIndex(steps)).toBe(1)
    expect(finishedClips(steps)).toEqual(['/c0.mp4'])
  })
  it('resume resets interrupted steps but keeps finished ones', () => {
    const steps = expandSteps([seg('a', { runs: 3 })])
    steps[0] = { ...steps[0]!, status: 'succeeded', path: '/x' }
    steps[1] = { ...steps[1]!, status: 'cancelled', error: 'x' }
    const resumed = resumableSteps(steps)
    expect(resumed.map((s) => s.status)).toEqual(['succeeded', 'pending', 'pending'])
    expect(segmentProgress({ segments: [seg('a')], steps })[0]).toMatchObject({ done: 1, total: 3, status: 'cancelled' })
  })
})
