import { afterEach, describe, expect, it } from 'vitest'

import {
  SETTINGS_RESTART_GRACE_MS,
  SETTINGS_RESTART_MAX_MS,
  activeSettingsRestart,
  beginSettingsRestart,
  blameSettingsRestart,
  clearSettingsRestart,
  resetSettingsRestartsForTest,
  trackSettingsRestart,
} from '@/lib/settings-restart'

const PROVIDER = 'llamacpp-upstream'
const MODEL = 'qwen3.5-4b'

function clockAt(start: number) {
  let now = start
  return {
    now: () => now,
    set: (value: number) => {
      now = value
    },
  }
}

function blame(
  error: object,
  overrides: Partial<Parameters<typeof blameSettingsRestart>[0]> = {}
) {
  return blameSettingsRestart({
    error,
    live: true,
    failedMessageId: undefined,
    providerId: PROVIDER,
    modelId: MODEL,
    eligible: true,
    ...overrides,
  })
}

afterEach(() => {
  resetSettingsRestartsForTest()
})

describe('settings restart marker', () => {
  it('is active while the restart runs and for a grace window after it', () => {
    const clock = clockAt(1_000)
    const settle = beginSettingsRestart(PROVIDER, MODEL, clock.now)

    expect(activeSettingsRestart(PROVIDER, MODEL, 1_500)).toMatchObject({
      providerId: PROVIDER,
      modelId: MODEL,
      startedAt: 1_000,
    })
    expect(
      activeSettingsRestart(PROVIDER, 'other-model', 1_500)
    ).toBeUndefined()

    clock.set(40_000)
    settle()
    expect(
      activeSettingsRestart(PROVIDER, MODEL, 40_000 + SETTINGS_RESTART_GRACE_MS)
    ).toMatchObject({ settledAt: 40_000 })
    expect(
      activeSettingsRestart(
        PROVIDER,
        MODEL,
        40_000 + SETTINGS_RESTART_GRACE_MS + 1
      )
    ).toBeUndefined()
    // An expired marker is dropped, not only hidden.
    expect(activeSettingsRestart(PROVIDER, MODEL, 40_001)).toBeUndefined()
  })

  it('stops counting a restart that never reports back', () => {
    beginSettingsRestart(PROVIDER, MODEL, () => 0)
    expect(
      activeSettingsRestart(PROVIDER, MODEL, SETTINGS_RESTART_MAX_MS)
    ).toBeDefined()
    expect(
      activeSettingsRestart(PROVIDER, MODEL, SETTINGS_RESTART_MAX_MS + 1)
    ).toBeUndefined()
  })

  it('settles the marker when the restart fails too', async () => {
    await expect(
      trackSettingsRestart(PROVIDER, MODEL, async () => {
        expect(
          activeSettingsRestart(PROVIDER, MODEL)?.settledAt
        ).toBeUndefined()
        throw new Error('load failed')
      })
    ).rejects.toThrow('load failed')
    expect(activeSettingsRestart(PROVIDER, MODEL)?.settledAt).toBeTypeOf(
      'number'
    )
  })

  it('is cleared on demand', () => {
    beginSettingsRestart(PROVIDER, MODEL)
    clearSettingsRestart(PROVIDER, MODEL)
    expect(activeSettingsRestart(PROVIDER, MODEL)).toBeUndefined()
  })
})

describe('blameSettingsRestart', () => {
  it('blames a live failure first seen while the restart is fresh', () => {
    beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    expect(blame(new Error('engine gone'), { now: 1_200 })).toBe(true)
  })

  it('does not blame a failure with no restart, of another model, or not eligible', () => {
    expect(blame(new Error('no restart'), { now: 1_000 })).toBe(false)

    beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    expect(
      blame(new Error('other model'), { modelId: 'other', now: 1_200 })
    ).toBe(false)
    expect(
      blame(new Error('context overflow'), { eligible: false, now: 1_200 })
    ).toBe(false)
  })

  it('never blames a failure seen before the restart began', () => {
    const stale = new Error('an earlier crash')
    expect(blame(stale, { now: 500 })).toBe(false)

    beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    expect(blame(stale, { now: 1_200 })).toBe(false)
  })

  it('never starts blaming an error rebuilt from a stored turn', () => {
    beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    expect(
      blame(new Error('stored'), {
        live: false,
        failedMessageId: 'msg-1',
        now: 1_200,
      })
    ).toBe(false)
  })

  it('keeps blaming the same failure and its stored turn after the window', () => {
    const settle = beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    settle()
    const live = new Error('engine gone')
    expect(blame(live, { failedMessageId: 'msg-1', now: 1_200 })).toBe(true)

    const later = 1_000 + SETTINGS_RESTART_GRACE_MS + 60_000
    expect(blame(live, { now: later })).toBe(true)
    // The page rebuilds the stored failed turn's error on every render.
    expect(
      blame(new Error('engine gone'), {
        live: false,
        failedMessageId: 'msg-1',
        now: later,
      })
    ).toBe(true)
    // A new failure after the window is not this restart's doing.
    expect(blame(new Error('a new crash'), { now: later })).toBe(false)
  })

  it('stops blaming new failures once the marker is cleared', () => {
    beginSettingsRestart(PROVIDER, MODEL, () => 1_000)
    const first = new Error('engine gone')
    expect(blame(first, { now: 1_100 })).toBe(true)

    clearSettingsRestart(PROVIDER, MODEL)
    expect(blame(new Error('after retry'), { now: 1_300 })).toBe(false)
    expect(blame(first, { now: 1_300 })).toBe(true)
  })
})
