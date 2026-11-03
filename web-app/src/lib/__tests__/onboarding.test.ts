import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'

import {
  currentOnboardingVariant,
  describeProviderState,
  hasPriorAppUse,
  hasValidProviders,
  isOnboardingInProgress,
  isOnboardingPending,
  resetForcedOnboardingRun,
  shouldEnterOnboarding,
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

  it('treats either an existing chat or usable provider as prior app use', () => {
    expect(hasPriorAppUse([], true)).toBe(true)
    expect(hasPriorAppUse([upstreamProvider], false)).toBe(true)
    expect(hasPriorAppUse([], false)).toBe(false)
  })

  it('counts an MLX model on disk as usable', () => {
    expect(
      hasValidProviders([{ provider: 'mlx', models: [{ id: 'local' }] }])
    ).toBe(true)
  })

  // The mechanism behind ATO-452: an install with only a broken link or the
  // bundled embedder used to pass the gate, skip onboarding, and then have
  // nothing to answer with on its first send.
  it('does not count a broken link as a model', () => {
    expect(
      hasValidProviders([
        { provider: 'llamacpp-upstream', models: [{ id: 'gone', missing: true }] },
      ])
    ).toBe(false)
  })

  it('does not count the embedding model as something to chat with', () => {
    expect(
      hasValidProviders([
        { provider: 'llamacpp-upstream', models: [{ id: EMBEDDING_MODEL_ID }] },
      ])
    ).toBe(false)
  })

  it('does not count a model behind a switched-off provider', () => {
    expect(
      hasValidProviders([{ ...upstreamProvider, active: false }])
    ).toBe(false)
  })

  it('does not count a cloud provider without a key', () => {
    useProviderRegistryStore.setState({
      providers: [{ provider: 'openai' }] as never,
      hasInitialized: true,
    })
    expect(
      hasValidProviders([
        { provider: 'openai', models: [{ id: 'gpt' }], api_key: '' },
      ])
    ).toBe(false)
    expect(
      hasValidProviders([
        { provider: 'openai', models: [], api_key: 'sk-test' },
      ])
    ).toBe(true)
  })

  it('judges a custom provider by loadable models, not list length', () => {
    useProviderRegistryStore.setState({
      providers: [],
      hasInitialized: true,
    } as never)
    expect(
      hasValidProviders([
        { provider: 'my-server', models: [{ id: 'gone', missing: true }] },
      ])
    ).toBe(false)
    expect(
      hasValidProviders([{ provider: 'my-server', models: [{ id: 'fine' }] }])
    ).toBe(true)
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

  it('replays an unfinished run from its first step', () => {
    useOnboardingStore.getState().begin('full', 'welcome')
    useOnboardingStore.getState().goTo('cloud')

    resetForcedOnboardingRun()

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'idle',
      step: null,
    })
  })

  it('enters even with chats and models, but not once finished', () => {
    const forced = {
      providers: [upstreamProvider],
      hasPriorThread: true,
      setupCompleted: false,
      force: true,
    }
    expect(shouldEnterOnboarding(forced)).toBe(true)
    expect(shouldEnterOnboarding({ ...forced, setupCompleted: true })).toBe(
      false
    )
  })

  it('leaves the flag alone in a shipped build', () => {
    vi.stubGlobal('FORCE_ONBOARDING', false)
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    resetForcedOnboardingRun()

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
  })
})

describe('entering the setup screen', () => {
  const freshInstall = {
    providers: [],
    hasPriorThread: false,
    setupCompleted: false,
    force: false,
  }

  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
  })

  it('sends a fresh install there', () => {
    expect(shouldEnterOnboarding(freshInstall)).toBe(true)
  })

  it('keeps everyone with a chat, a model or a finished setup out', () => {
    expect(
      shouldEnterOnboarding({ ...freshInstall, hasPriorThread: true })
    ).toBe(false)
    expect(
      shouldEnterOnboarding({ ...freshInstall, providers: [upstreamProvider] })
    ).toBe(false)
    expect(
      shouldEnterOnboarding({ ...freshInstall, setupCompleted: true })
    ).toBe(false)
  })

  // The Windows/Linux backend step relaunches the app in the middle of the
  // flow; the next launch has to come back to it whatever else is true.
  it('resumes a run that was on screen when the app closed', () => {
    useOnboardingStore.getState().begin('full', 'backend')
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    expect(isOnboardingInProgress()).toBe(true)
    expect(
      shouldEnterOnboarding({
        ...freshInstall,
        providers: [upstreamProvider],
        hasPriorThread: true,
        setupCompleted: true,
      })
    ).toBe(true)
    // Startup work that waits for onboarding keeps waiting.
    expect(isOnboardingPending([upstreamProvider])).toBe(true)
  })

  it('lets the app take over once the run hands off', () => {
    useOnboardingStore.getState().begin('full', 'welcome')
    useOnboardingStore.getState().handOff('chat')
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    expect(isOnboardingInProgress()).toBe(false)
    expect(isOnboardingPending([])).toBe(false)
    expect(
      shouldEnterOnboarding({ ...freshInstall, setupCompleted: true })
    ).toBe(false)
  })
})

describe('variants without a setup screen', () => {
  const freshInstall = {
    providers: [],
    hasPriorThread: false,
    setupCompleted: false,
    force: false,
  }

  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'none')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a fresh none install out of onboarding, even in a forced build', () => {
    expect(shouldEnterOnboarding(freshInstall)).toBe(false)
    expect(shouldEnterOnboarding({ ...freshInstall, force: true })).toBe(false)
  })

  // Nothing waits for a setup screen that never comes: on Windows/Linux the
  // startup coordinator picks the GPU backend as soon as hardware is known.
  it('lets startup work run at once with nothing installed', () => {
    vi.stubGlobal('FORCE_ONBOARDING', true)

    expect(isOnboardingPending([])).toBe(false)
  })

  it('still resumes a run that began under another variant', () => {
    useOnboardingStore.getState().begin('full', 'backend')

    expect(currentOnboardingVariant()).toBe('full')
    expect(shouldEnterOnboarding(freshInstall)).toBe(true)
    expect(isOnboardingPending([])).toBe(true)
  })

  it('sends a model-only install to the setup screen like the full flow', () => {
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'model_only')

    expect(currentOnboardingVariant()).toBe('model_only')
    expect(shouldEnterOnboarding(freshInstall)).toBe(true)
    expect(isOnboardingPending([])).toBe(true)
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

  it('does not count a broken link or the embedder as being on disk', () => {
    expect(
      describeProviderState([
        {
          provider: 'llamacpp',
          models: [{ id: 'gone', missing: true }, { id: EMBEDDING_MODEL_ID }],
        },
      ])
    ).toMatchObject({ hadLocalModelOnDisk: false })
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
