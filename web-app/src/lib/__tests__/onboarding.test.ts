import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'

import {
  describeProviderState,
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

describe('describeProviderState', () => {
  beforeEach(() => {
    useProviderRegistryStore.setState({
      providers: [],
      hasInitialized: false,
    } as never)
  })

  it('separates a model on disk from a configured cloud key', () => {
    expect(
      describeProviderState([
        { provider: 'llamacpp', models: [{ id: 'local' }] },
        { provider: 'openai', models: [], api_key: '' },
      ])
    ).toMatchObject({ hadLocalModelOnDisk: true, hadCloudKey: false })

    expect(
      describeProviderState([
        { provider: 'llamacpp', models: [] },
        { provider: 'openai', models: [], api_key: 'sk-test' },
      ])
    ).toMatchObject({ hadLocalModelOnDisk: false, hadCloudKey: true })
  })

  it('counts MLX models as being on disk', () => {
    expect(
      describeProviderState([{ provider: 'mlx', models: [{ id: 'local' }] }])
    ).toMatchObject({ hadLocalModelOnDisk: true })
  })

  it('reports the gate verbatim, so a disagreement with it stays visible', () => {
    // A registered cloud provider with a key satisfies the gate but puts
    // nothing on disk — exactly the split `had_any_model` used to hide.
    useProviderRegistryStore.setState({
      providers: [{ provider: 'openai' }] as never,
      hasInitialized: true,
    })

    expect(
      describeProviderState([
        { provider: 'openai', models: [], api_key: 'sk-test' },
      ])
    ).toEqual({
      hadLocalModelOnDisk: false,
      hadCloudKey: true,
      gateValidProviders: true,
    })
  })

  it('reports an install that left with nothing at all', () => {
    // The case the old `had_any_model` could not express: providers exist and
    // the picker had rows, but nothing is on disk and no key is set.
    expect(
      describeProviderState([
        { provider: 'llamacpp', models: [] },
        { provider: 'openai', models: [] },
      ])
    ).toEqual({
      hadLocalModelOnDisk: false,
      hadCloudKey: false,
      gateValidProviders: false,
    })
  })

  it('does not count a local provider as a cloud key', () => {
    expect(
      describeProviderState([
        { provider: 'llamacpp', models: [], api_key: 'unused' },
      ])
    ).toMatchObject({ hadCloudKey: false })
  })
})
