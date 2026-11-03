/**
 * The old first-run screen opened on the GPU backend step on a first Windows
 * or Linux launch and went straight to the models everywhere else. The flow
 * now reads that from the machine through `useStepContext`; the order of the
 * steps it unlocks is `lib/onboarding/steps`' (and its tests').
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { resolveSteps, type StepContext } from '@/lib/onboarding/steps'

// The other steps' offers have tests of their own; none is shown here.
vi.mock('../steps/cloudAvailability', () => ({
  useCloudProviderCount: () => 0,
}))
vi.mock('../steps/mediaAvailability', () => ({ useMediaCardCount: () => 0 }))
vi.mock('../steps/permissionsAvailability', () => ({
  usePermissionRowCount: () => 0,
}))
vi.mock('../steps/serverAvailability', () => ({
  useLocalApiServerOffered: () => false,
}))

import { useStepContext } from '../useStepContext'

const shown = (context: StepContext) =>
  resolveSteps('full', context).map((step) => step.id)

describe('which machine sees the GPU backend step', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it.each([
    ['Windows', true, false],
    // Linux installs on the CPU build with a Vulkan build to offer, exactly
    // the situation the step exists for (ATO-464).
    ['Linux', false, true],
  ])(
    'offers it on a first %s launch, until it ran once',
    (_platform, windows, linux) => {
      vi.stubGlobal('IS_WINDOWS', windows)
      vi.stubGlobal('IS_LINUX', linux)
      const { result, rerender } = renderHook(() => useStepContext())

      expect(shown(result.current)).toEqual(['welcome', 'backend', 'model'])

      // Set when the step resolves — and before a "Restart now", which
      // otherwise showed the step a second time (ATO-459).
      localStorage.setItem(localStorageKey.llamacppOnboardingDone, 'downloaded')
      rerender()

      expect(shown(result.current)).toEqual(['welcome', 'model'])
    }
  )

  it('never offers it on a Mac', () => {
    vi.stubGlobal('IS_WINDOWS', false)
    vi.stubGlobal('IS_LINUX', false)

    const { result } = renderHook(() => useStepContext())

    expect(result.current.winOrLinux).toBe(false)
    expect(shown(result.current)).toEqual(['welcome', 'model'])
  })
})
