import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import { localStorageKey } from '@/constants/localStorage'
import {
  captureBackendStepShown,
  captureOnboardingCompleted,
  captureOnboardingModelReminder,
  captureProviderKeyConfigured,
  captureSetupLocalModelRun,
  captureSetupScreenShown,
  isFirstLaunch,
} from '@/lib/onboarding-telemetry'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))

const lastCall = () => {
  const calls = vi.mocked(posthog.capture).mock.calls
  return calls[calls.length - 1] as [string, Record<string, unknown>]
}

beforeEach(() => {
  vi.mocked(posthog.capture).mockClear()
  localStorage.clear()
})

describe('captureOnboardingCompleted', () => {
  it('reports the exit path and how long the flow took', () => {
    captureOnboardingCompleted({
      exitPath: 'imported',
      hadAnyModel: true,
      stepReached: 'model',
      startedAtMs: Date.now() - 5000,
    })
    const [event, props] = lastCall()
    expect(event).toBe('onboarding_completed')
    expect(props.exit_path).toBe('imported')
    expect(props.had_any_model).toBe(true)
    expect(props.step_reached).toBe('model')
    expect(props.duration_ms).toBeGreaterThanOrEqual(5000)
  })

  it('defaults everything the call site may not know', () => {
    captureOnboardingCompleted({ exitPath: 'timeout' })
    const [, props] = lastCall()
    expect(props.had_any_model).toBe(false)
    expect(props.step_reached).toBe('model')
    expect(props.duration_ms).toBeNull()
  })

  it('attaches platform and app version like the sibling events', () => {
    captureOnboardingCompleted({ exitPath: 'skipped' })
    const [, props] = lastCall()
    expect(props.app_version).toBe('test')
    expect(props.platform).toBeDefined()
  })
})

describe('captureSetupLocalModelRun', () => {
  it('converts bytes to a rounded GB figure', () => {
    captureSetupLocalModelRun({
      trigger: 'manual',
      source: 'lmstudio',
      format: 'gguf',
      sizeBytes: 4 * 1024 ** 3,
      detectedCount: 3,
    })
    const [event, props] = lastCall()
    expect(event).toBe('setup_local_model_run')
    expect(props.trigger).toBe('manual')
    expect(props.size_gb).toBe(4)
    expect(props.detected_count).toBe(3)
  })

  it('nulls a missing size instead of reporting zero', () => {
    captureSetupLocalModelRun({ trigger: 'installed_recommended' })
    const [, props] = lastCall()
    expect(props.size_gb).toBeNull()
    expect(props.source).toBeNull()
    expect(props.detected_count).toBeNull()
  })
})

describe('captureSetupScreenShown', () => {
  it('marks the auto-start case as never rendered', () => {
    captureSetupScreenShown({ recommendedCount: 0, rendered: false })
    const [event, props] = lastCall()
    expect(event).toBe('setup_screen_shown')
    expect(props.rendered).toBe(false)
    expect(props.recommended_count).toBe(0)
  })

  it('defaults a missing count to zero', () => {
    captureSetupScreenShown({ rendered: true })
    expect(lastCall()[1].recommended_count).toBe(0)
  })
})

describe('captureBackendStepShown', () => {
  it('emits the entry event with the only phase knowable at mount', () => {
    captureBackendStepShown()
    const [event, props] = lastCall()
    expect(event).toBe('backend_step_shown')
    expect(props.phase).toBe('detecting')
  })
})

describe('captureOnboardingModelReminder', () => {
  it.each(['shown', 'download', 'later'] as const)(
    'reports the %s action',
    (action) => {
      captureOnboardingModelReminder(action)
      const [event, props] = lastCall()
      expect(event).toBe('onboarding_model_reminder')
      expect(props.action).toBe(action)
    }
  )
})

describe('captureProviderKeyConfigured', () => {
  it('reports the provider and whether it happened during onboarding', () => {
    captureProviderKeyConfigured({
      provider: 'anthropic',
      duringOnboarding: true,
    })
    const [event, props] = lastCall()
    expect(event).toBe('provider_key_configured')
    expect(props.provider).toBe('anthropic')
    expect(props.during_onboarding).toBe(true)
    // The key itself must never appear in any form.
    expect(Object.keys(props)).not.toContain('api_key')
  })
})

describe('isFirstLaunch', () => {
  it('is true when neither first-use marker exists', () => {
    expect(isFirstLaunch()).toBe(true)
  })

  it('is false once onboarding has been completed', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    expect(isFirstLaunch()).toBe(false)
  })

  it('is false once a version has been seen, even without setup', () => {
    // Covers users upgrading from a build that predates this flag.
    localStorage.setItem(localStorageKey.lastSeenVersion, '2.0.13')
    expect(isFirstLaunch()).toBe(false)
  })
})

describe('emitter resilience', () => {
  it('never lets a telemetry failure escape into the UI', () => {
    vi.mocked(posthog.capture).mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() => captureOnboardingCompleted({ exitPath: 'skipped' })).not.toThrow()
  })
})
