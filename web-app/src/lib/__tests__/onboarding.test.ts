import { beforeEach, describe, expect, it } from 'vitest'

import { hasValidProviders, isOnboardingPending } from '../onboarding'

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
})
