import { describe, expect, it } from 'vitest'

import {
  getOnboardingVariant,
  nextStep,
  normalizeStep,
  prevStep,
  progressOf,
  resolveSteps,
  type StepContext,
} from '../steps'

const mac: StepContext = {
  winOrLinux: false,
  backendStepDone: false,
  permissionRows: 2,
  cloudProviders: 12,
  mediaCards: 2,
  localApiServer: true,
}
const windows: StepContext = { ...mac, winOrLinux: true, permissionRows: 0 }

const ids = (context: StepContext) =>
  resolveSteps('full', context).map((step) => step.id)

describe('onboarding steps', () => {
  it('runs the full flow on every install for now', () => {
    expect(getOnboardingVariant()).toBe('full')
  })

  it('shows every step of the design on a Mac', () => {
    expect(ids(mac)).toEqual([
      'welcome',
      'model',
      'permissions',
      'cloud',
      'media',
      'purpose',
      'server',
    ])
  })

  it('picks the GPU backend before the model on Windows until that ran', () => {
    expect(ids(windows)).toEqual([
      'welcome',
      'backend',
      'model',
      'cloud',
      'media',
      'purpose',
      'server',
    ])
    expect(ids({ ...windows, backendStepDone: true })).not.toContain('backend')
  })

  it('drops the steps a build or machine has nothing for', () => {
    expect(
      ids({
        ...mac,
        permissionRows: 0,
        cloudProviders: 0,
        mediaCards: 0,
        localApiServer: false,
      })
    ).toEqual(['welcome', 'model'])
  })

  it('walks Continue in order and hands off after the last step', () => {
    const steps = resolveSteps('full', mac)
    expect(nextStep(steps, 'welcome')).toBe('model')
    expect(nextStep(steps, 'media')).toBe('purpose')
    expect(nextStep(steps, 'purpose')).toBeNull()
    expect(
      nextStep(resolveSteps('full', { ...mac, localApiServer: false }), 'media')
    ).toBeNull()
  })

  it('never reaches the server step by Continue, and goes back from it to purpose', () => {
    const steps = resolveSteps('full', mac)
    expect(nextStep(steps, 'server')).toBeNull()
    expect(prevStep(steps, 'server')).toBe('purpose')
    expect(prevStep(steps, 'purpose')).toBe('media')
    expect(prevStep(steps, 'welcome')).toBeNull()
  })

  it('counts the steps of the design, with the server step on the purpose number', () => {
    const steps = resolveSteps('full', mac)
    expect(progressOf(steps, 'welcome')).toEqual({ index: 1, count: 6 })
    expect(progressOf(steps, 'model')).toEqual({ index: 2, count: 6 })
    expect(progressOf(steps, 'purpose')).toEqual({ index: 6, count: 6 })
    expect(progressOf(steps, 'server')).toEqual({ index: 6, count: 6 })
  })

  it('shows no counter on the backend step, and counts only what is shown', () => {
    const steps = resolveSteps('full', windows)
    expect(progressOf(steps, 'backend')).toBeNull()
    expect(progressOf(steps, 'model')).toEqual({ index: 2, count: 5 })
  })

  describe('resuming a saved run', () => {
    it('keeps a step that still applies', () => {
      expect(normalizeStep('full', resolveSteps('full', mac), 'cloud')).toBe(
        'cloud'
      )
    })

    it('lands on the model after the backend relaunch', () => {
      const afterRelaunch = resolveSteps('full', {
        ...windows,
        backendStepDone: true,
      })
      expect(normalizeStep('full', afterRelaunch, 'backend')).toBe('model')
    })

    it('starts from the first step when nothing was saved', () => {
      expect(normalizeStep('full', resolveSteps('full', mac), null)).toBe(
        'welcome'
      )
    })

    it('falls back to the last step left when the saved one and everything after it is gone', () => {
      const trimmed = resolveSteps('full', {
        ...mac,
        mediaCards: 0,
        localApiServer: false,
      })
      expect(normalizeStep('full', trimmed, 'purpose')).toBe('cloud')
    })

    it('has nowhere to go when a variant shows no steps', () => {
      expect(normalizeStep('full', [], 'model')).toBeNull()
    })
  })
})
