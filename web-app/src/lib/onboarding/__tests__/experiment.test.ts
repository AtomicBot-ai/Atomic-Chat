import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import { localStorageKey } from '@/constants/localStorage'
import {
  assignOnboardingCohort,
  captureOnboardingCohort,
  drawOnboardingVariant,
  ONBOARDING_EXPERIMENT,
  readOnboardingCohort,
  registerOnboardingCohort,
} from '../experiment'
import { getOnboardingVariant } from '../steps'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))

const stored = () =>
  JSON.parse(localStorage.getItem(localStorageKey.onboardingCohort) ?? 'null')

beforeEach(() => {
  localStorage.clear()
  vi.mocked(posthog.capture).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drawing a variant', () => {
  it('gives each variant an equal third of the range', () => {
    expect(drawOnboardingVariant(() => 0)).toBe('full')
    expect(drawOnboardingVariant(() => 0.33)).toBe('full')
    expect(drawOnboardingVariant(() => 0.34)).toBe('model_only')
    expect(drawOnboardingVariant(() => 0.66)).toBe('model_only')
    expect(drawOnboardingVariant(() => 0.67)).toBe('none')
    expect(drawOnboardingVariant(() => 0.999999)).toBe('none')
  })

  it('stays in range even if the source returns 1', () => {
    expect(drawOnboardingVariant(() => 1)).toBe('none')
  })

  it('splits a large sample roughly evenly', () => {
    const counts = { full: 0, model_only: 0, none: 0 }
    for (let i = 0; i < 30_000; i++) counts[drawOnboardingVariant()] += 1
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(9_400)
      expect(count).toBeLessThan(10_600)
    }
  })
})

describe('joining the experiment', () => {
  it('persists the cohort before analytics is ready and starts runs on it', () => {
    const cohort = assignOnboardingCohort({
      firstLaunch: true,
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    })

    expect(cohort).toEqual({
      experiment: ONBOARDING_EXPERIMENT,
      variant: 'model_only',
      assignedAt: 1_700_000_000_000,
    })
    expect(stored()).toEqual(cohort)
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(getOnboardingVariant()).toBe('model_only')
  })

  it('keeps the cohort on every later launch, without drawing or reporting again', () => {
    assignOnboardingCohort({ firstLaunch: true, random: () => 0.9 })
    vi.mocked(posthog.capture).mockClear()
    const random = vi.fn(() => 0)

    const again = assignOnboardingCohort({ firstLaunch: false, random })

    expect(again?.variant).toBe('none')
    expect(random).not.toHaveBeenCalled()
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(getOnboardingVariant()).toBe('none')
  })

  it('leaves out an install that used the app before the experiment', () => {
    expect(assignOnboardingCohort({ firstLaunch: false })).toBeNull()
    expect(stored()).toBeNull()
    expect(posthog.capture).not.toHaveBeenCalled()
    // It keeps today's flow should it ever see the setup screen again.
    expect(getOnboardingVariant()).toBe('full')
  })

  it('leaves out a dev build that pins a variant, which still shows that variant', () => {
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'none')

    expect(assignOnboardingCohort({ firstLaunch: true })).toBeNull()
    expect(stored()).toBeNull()
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(getOnboardingVariant()).toBe('none')
  })

  it('lets a pinned dev variant win over a stored cohort', () => {
    assignOnboardingCohort({ firstLaunch: true, random: () => 0 })
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'model_only')

    expect(getOnboardingVariant()).toBe('model_only')
  })

  it('ignores a cohort of another experiment or a damaged record', () => {
    localStorage.setItem(
      localStorageKey.onboardingCohort,
      JSON.stringify({ experiment: 'onboarding_v0', variant: 'none' })
    )
    expect(readOnboardingCohort()).toBeNull()
    localStorage.setItem(localStorageKey.onboardingCohort, '{not json')
    expect(readOnboardingCohort()).toBeNull()
    localStorage.setItem(
      localStorageKey.onboardingCohort,
      JSON.stringify({ experiment: ONBOARDING_EXPERIMENT, variant: 'short' })
    )
    expect(readOnboardingCohort()).toBeNull()
    expect(getOnboardingVariant()).toBe('full')
  })

  it('stays out when storage refuses the cohort, so no launch reports a cohort it lost', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })

    expect(assignOnboardingCohort({ firstLaunch: true })).toBeNull()
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(getOnboardingVariant()).toBe('full')
  })
})

describe('telling PostHog', () => {
  /** A client that keeps what it was told, as PostHog's person and events would. */
  const fakePostHog = () => {
    const state = {
      superProperties: {} as Record<string, unknown>,
      personOnce: {} as Record<string, unknown>,
    }
    return {
      state,
      register: (properties: Record<string, unknown>) => {
        Object.assign(state.superProperties, properties)
      },
      setPersonProperties: (
        _set?: Record<string, unknown>,
        setOnce?: Record<string, unknown>
      ) => {
        // `$set_once`: a value already on the person is never replaced.
        state.personOnce = { ...setOnce, ...state.personOnce }
      },
    }
  }

  it('puts the cohort on the person once and on every event', () => {
    assignOnboardingCohort({
      firstLaunch: true,
      random: () => 0.1,
      now: () => Date.UTC(2026, 9, 23, 12),
    })
    const client = fakePostHog()

    registerOnboardingCohort(client)

    expect(client.state.superProperties).toEqual({
      onboarding_experiment: ONBOARDING_EXPERIMENT,
      onboarding_variant: 'full',
    })
    expect(client.state.personOnce).toEqual({
      onboarding_experiment: ONBOARDING_EXPERIMENT,
      onboarding_variant: 'full',
      onboarding_assigned_at: '2026-10-23T12:00:00.000Z',
    })
  })

  it('never moves a person to another cohort on a later launch', () => {
    assignOnboardingCohort({ firstLaunch: true, random: () => 0.1 })
    const client = fakePostHog()
    registerOnboardingCohort(client)
    // The stored cohort is lost and the device draws again.
    localStorage.removeItem(localStorageKey.onboardingCohort)
    assignOnboardingCohort({ firstLaunch: true, random: () => 0.9 })

    registerOnboardingCohort(client)

    expect(client.state.personOnce.onboarding_variant).toBe('full')
  })

  it('says nothing for an install outside the experiment', () => {
    const client = fakePostHog()

    registerOnboardingCohort(client)

    expect(client.state.superProperties).toEqual({})
    expect(client.state.personOnce).toEqual({})
  })
})

describe('capturing the persisted assignment', () => {
  const assignedAt = Date.UTC(2026, 9, 23, 12)
  const accepted = () => ({
    uuid: '00000000-0000-4000-8000-000000000001',
    event: 'onboarding_cohort_assigned',
    properties: {},
    timestamp: new Date(assignedAt),
  })

  beforeEach(() => {
    assignOnboardingCohort({
      firstLaunch: true,
      random: () => 0.5,
      now: () => assignedAt,
    })
  })

  it('recovers an old assignment at its original time and persists acceptance', () => {
    const client = { capture: vi.fn(accepted) }
    captureOnboardingCohort(client)

    expect(client.capture).toHaveBeenCalledExactlyOnceWith(
      'onboarding_cohort_assigned',
      {
        onboarding_experiment: ONBOARDING_EXPERIMENT,
        onboarding_variant: 'model_only',
      },
      { timestamp: new Date(assignedAt), send_instantly: true }
    )
    expect(stored()).toMatchObject({ assignedAt, assignmentCaptured: true })

    // A later launch restores the same stored cohort without another draw.
    assignOnboardingCohort({ firstLaunch: false })
    captureOnboardingCohort(client)
    expect(client.capture).toHaveBeenCalledTimes(1)
  })

  it('retries a capture the SDK declined without changing the cohort or time', () => {
    const client = {
      capture: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockImplementation(accepted),
    }
    captureOnboardingCohort(client)
    expect(stored().assignmentCaptured).toBeUndefined()

    captureOnboardingCohort(client)
    expect(client.capture).toHaveBeenCalledTimes(2)
    expect(client.capture.mock.calls[0]).toEqual(client.capture.mock.calls[1])
    expect(stored()).toMatchObject({
      variant: 'model_only',
      assignedAt,
      assignmentCaptured: true,
    })
  })

  it('keeps the assignment pending after a capture exception', () => {
    const client = {
      capture: vi.fn(() => {
        throw new Error('not ready')
      }),
    }
    expect(() => captureOnboardingCohort(client)).not.toThrow()
    expect(stored().assignmentCaptured).toBeUndefined()
  })

  it('does not invent a timestamp for a damaged assignment', () => {
    localStorage.setItem(
      localStorageKey.onboardingCohort,
      JSON.stringify({
        experiment: ONBOARDING_EXPERIMENT,
        variant: 'full',
      })
    )
    const client = { capture: vi.fn(accepted) }
    captureOnboardingCohort(client)
    expect(client.capture).not.toHaveBeenCalled()
    expect(stored()).toEqual({
      experiment: ONBOARDING_EXPERIMENT,
      variant: 'full',
    })
  })
})
