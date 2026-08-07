import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'

import {
  hasValidProviders,
  isOnboardingPending,
  resetForcedOnboardingRun,
} from '../onboarding'

const upstreamProvider = {
  provider: 'llamacpp-upstream',
  models: [{ id: 'local-model' }],
}

describe('onboarding provider gate', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('treats an upstream provider with a model as usable', () => {
    expect(hasValidProviders([upstreamProvider])).toBe(true)
  })

  it('does not keep legacy upstream users in onboarding without a setup flag', () => {
    expect(isOnboardingPending([upstreamProvider])).toBe(false)
  })

  it('keeps a fresh install in onboarding until the flag is persisted', () => {
    expect(isOnboardingPending([])).toBe(true)

    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    expect(isOnboardingPending([])).toBe(false)
  })
})

describe('forced onboarding runs', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('FORCE_ONBOARDING', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('enters onboarding even with a usable provider', () => {
    expect(isOnboardingPending([upstreamProvider])).toBe(true)
  })

  it('does not block the way out once onboarding was left', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    expect(isOnboardingPending([upstreamProvider])).toBe(false)
  })

  it('replays the flow by clearing the flag at launch', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    resetForcedOnboardingRun()

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(isOnboardingPending([upstreamProvider])).toBe(true)
  })

  it('leaves the flag alone in a shipped build', () => {
    vi.stubGlobal('FORCE_ONBOARDING', false)
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    resetForcedOnboardingRun()

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
  })
})
