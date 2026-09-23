import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DURATION_TARGETS,
  durationOptions,
  formatSeconds,
  framesForSeconds,
  secondsForFrames,
  snapFrames,
  type FrameLattice,
} from '../duration'

const LTX: FrameLattice = { fps: 24, min: 9, max: 257, step: 8, offset: 1 }
const WAN: FrameLattice = { fps: 24, min: 5, max: 241, step: 4, offset: 1 }

describe('snapFrames', () => {
  it.each([
    [LTX, 24, 25],
    [LTX, 48, 49],
    [LTX, 49, 49],
    [LTX, 52, 49],
    [LTX, 53, 57],
    [LTX, 1, 9],
    [LTX, 0, 9],
    [LTX, -40, 9],
    [LTX, 257, 257],
    [LTX, 300, 257],
    [WAN, 24, 25],
    [WAN, 120, 121],
    [WAN, 4, 5],
    [WAN, 999, 241],
  ] as const)('snaps %o: %i frames -> %i', (lattice, frames, expected) => {
    expect(snapFrames(frames, lattice)).toBe(expected)
  })

  it('rounds a range boundary that is off the lattice inwards', () => {
    // [10, 250] on 8k+1: the smallest point at or above 10 is 17, the largest at or below 250 is 249.
    const off = { ...LTX, min: 10, max: 250 }
    expect(snapFrames(1, off)).toBe(17)
    expect(snapFrames(999, off)).toBe(249)
    // A range too narrow for any point still answers its lower point.
    expect(snapFrames(20, { ...LTX, min: 18, max: 20 })).toBe(25)
  })
})

describe('framesForSeconds and secondsForFrames', () => {
  it('turns the reference durations into the reference frame counts', () => {
    expect([1, 2, 3, 5].map((s) => framesForSeconds(s, LTX))).toEqual([25, 49, 73, 121])
    expect([1, 2, 3, 5].map((s) => framesForSeconds(s, WAN))).toEqual([25, 49, 73, 121])
    expect(framesForSeconds(0.1, LTX)).toBe(9)
    expect(framesForSeconds(60, LTX)).toBe(257)
    expect(secondsForFrames(49, 24)).toBeCloseTo(2.0417, 3)
    expect(secondsForFrames(49, 0)).toBe(0)
  })
})

describe('formatSeconds', () => {
  it('shows one decimal', () => {
    expect(formatSeconds(1)).toBe('1.0')
    expect(formatSeconds(49 / 24)).toBe('2.0')
    expect(formatSeconds(257 / 24)).toBe('10.7')
    expect(formatSeconds(0)).toBe('0.0')
  })
})

describe('durationOptions', () => {
  it('offers the four reference durations for LTX and Wan', () => {
    expect(DEFAULT_DURATION_TARGETS).toEqual([1, 2, 3, 5])
    expect(durationOptions(LTX)).toEqual([
      { frames: 25, seconds: 1 },
      { frames: 49, seconds: 2 },
      { frames: 73, seconds: 3 },
      { frames: 121, seconds: 5 },
    ])
    expect(durationOptions(WAN).map((o) => o.frames)).toEqual([25, 49, 73, 121])
  })

  it('adds extra frame counts at their own seconds, deduplicated and sorted', () => {
    const options = durationOptions(LTX, [1, 2], [121, 49, 200, Number.NaN])
    expect(options).toEqual([
      { frames: 25, seconds: 1 },
      { frames: 49, seconds: 2 },
      { frames: 121, seconds: 121 / 24 },
      { frames: 201, seconds: 201 / 24 },
    ])
  })

  it('collapses targets that land on the same frame count and drops bad ones', () => {
    // 2.0 s and 2.1 s both round to 49 frames on 8k+1; the first target names it.
    expect(durationOptions(LTX, [2.1, 2, 0, -1, Number.POSITIVE_INFINITY])).toEqual([
      { frames: 49, seconds: 2.1 },
    ])
    expect(durationOptions(LTX, [])).toEqual([])
  })
})
