import { describe, expect, it } from 'vitest'

import {
  advanceSpeedSample,
  bytesUnit,
  formatBytes,
  formatEta,
  formatProgressPair,
  formatSpeed,
  newSpeedSample,
  shortModelName,
} from '../downloadFormat'

const MB = 1024 * 1024
const GB = MB * 1024

describe('formatProgressPair', () => {
  it('picks the unit from the total so the pair stays comparable', () => {
    // `430 MB / 15 GB` makes the two numbers incomparable at a glance; both
    // sides use the total's unit instead.
    expect(formatProgressPair(0.42 * GB, 15 * GB)).toBe('0.42 / 15.00 GB')
    expect(formatProgressPair(120 * MB, 800 * MB)).toBe('120 / 800 MB')
  })

  it('says nothing while the total is unknown', () => {
    // The downloader reports 0 until the HEAD request lands.
    expect(formatProgressPair(0, 0)).toBe('')
  })

  it('exposes the same unit choice to callers', () => {
    expect(bytesUnit(2 * GB)).toBe('GB')
    expect(bytesUnit(500 * MB)).toBe('MB')
  })

  it('does not render a negative or non-finite size', () => {
    expect(formatBytes(-1)).toBe('0')
    expect(formatBytes(Number.NaN)).toBe('0')
  })
})

describe('formatSpeed', () => {
  it('scales the unit to the rate', () => {
    expect(formatSpeed(18.4 * MB)).toBe('18.4 MB/s')
    expect(formatSpeed(512 * 1024)).toBe('512 KB/s')
    expect(formatSpeed(300)).toBe('300 B/s')
  })

  it('returns null when there is no usable sample', () => {
    // The row omits the field entirely rather than printing `0 MB/s`, which
    // reads as a stalled download.
    expect(formatSpeed(0)).toBeNull()
    expect(formatSpeed(undefined)).toBeNull()
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('formatEta', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatEta(30 * MB, MB)).toBe('30s')
    expect(formatEta(776 * MB, MB)).toBe('12m 56s')
    expect(formatEta(3860 * MB, MB)).toBe('1h 04m')
  })

  it('refuses to guess without a rate or a remainder', () => {
    expect(formatEta(GB, 0)).toBeNull()
    expect(formatEta(0, MB)).toBeNull()
    expect(formatEta(-1, MB)).toBeNull()
  })

  it('stays silent when the estimate would be absurd', () => {
    // A stalled transfer produces a multi-day figure that tells the user
    // nothing true; a missing ETA is more honest than a wrong one.
    expect(formatEta(100 * GB, 100)).toBeNull()
  })
})

describe('shortModelName', () => {
  it('drops the HuggingFace org prefix', () => {
    expect(shortModelName('unsloth/Qwen3-4B-GGUF')).toBe('Qwen3-4B-GGUF')
  })

  it('leaves an unqualified or trailing-slash id alone', () => {
    expect(shortModelName('local-model')).toBe('local-model')
    expect(shortModelName('org/')).toBe('org/')
  })
})

describe('advanceSpeedSample', () => {
  it('needs two samples before it reports a rate', () => {
    const first = advanceSpeedSample(undefined, 0, 1_000)
    expect(first.bytesPerSecond).toBe(0)

    const second = advanceSpeedSample(first, 5 * MB, 2_000)
    expect(second.bytesPerSecond).toBe(5 * MB)
  })

  it('smooths later samples instead of tracking every spike', () => {
    // A chunk that arrives late must not halve the displayed speed outright.
    const a = advanceSpeedSample(undefined, 0, 0)
    const b = advanceSpeedSample(a, 10 * MB, 1_000)
    const c = advanceSpeedSample(b, 12 * MB, 2_000)

    expect(b.bytesPerSecond).toBe(10 * MB)
    // 0.7 * 10 + 0.3 * 2 = 7.6 MB/s, not the raw 2 MB/s.
    expect(c.bytesPerSecond / MB).toBeCloseTo(7.6, 5)
  })

  it('ignores samples closer together than the minimum window', () => {
    const a = advanceSpeedSample(undefined, 0, 0)
    const b = advanceSpeedSample(a, 1024, 100)
    // Dividing 1 KB by 100ms would report 10 KB/s from noise.
    expect(b).toBe(a)
  })

  it('ignores a sample that did not advance', () => {
    const a = newSpeedSample(5 * MB, 0)
    expect(advanceSpeedSample(a, 5 * MB, 5_000)).toBe(a)
  })

  it('rebaselines when the byte counter goes backwards', () => {
    // A restarted transfer resets to 0; keeping the old baseline would turn
    // the next sample into a fabricated burst.
    const a = advanceSpeedSample(undefined, 0, 0)
    const b = advanceSpeedSample(a, 10 * MB, 1_000)
    const restarted = advanceSpeedSample(b, 0, 2_000)

    expect(restarted.bytesPerSecond).toBe(0)
    expect(restarted.atBytes).toBe(0)
  })
})
