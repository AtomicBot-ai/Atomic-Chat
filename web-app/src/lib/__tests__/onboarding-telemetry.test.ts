import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import { localStorageKey } from '@/constants/localStorage'
import {
  buildRecommendedImpressions,
  captureBackendStepResolved,
  captureBackendStepShown,
  classifyDetectionFailure,
  clearBackendRestartIntent,
  markBackendRestartIntent,
  readRecheckOutcome,
  reportBackendRestartIntent,
  captureOnboardingCompleted,
  captureOnboardingModelReminder,
  captureProviderKeyConfigured,
  captureSetupLocalModelRun,
  captureSetupScreenShown,
  captureRecommendedModelsShown,
  isFirstLaunch,
  markOnboardingInFlight,
  reportAbandonedOnboarding,
} from '@/lib/onboarding-telemetry'

vi.mock('posthog-js', () => ({
  // `has_opted_in_capturing` is what `queuedCapture` checks before sending;
  // without it every event would sit in the startup queue instead.
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
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
    captureOnboardingCompleted({ exitPath: 'dismissed' })
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
    expect(() =>
      captureOnboardingCompleted({ exitPath: 'dismissed' })
    ).not.toThrow()
  })
})

describe('had_any_model is no longer the only answer', () => {
  it('reports the split alongside the legacy field, and the gate with it', () => {
    captureOnboardingCompleted({
      exitPath: 'timeout',
      hadAnyModel: true,
      providerState: {
        hadLocalModelOnDisk: false,
        hadCloudKey: false,
        gateValidProviders: false,
      },
    })

    // The exact case that used to read as a success: the picker had rows to
    // show, so `had_any_model` is true, while the user left with nothing.
    expect(lastCall()[1]).toMatchObject({
      had_any_model: true,
      had_local_model_on_disk: false,
      had_cloud_key: false,
      gate_valid_providers: false,
    })
  })

  it('nulls the split rather than guessing when it was not supplied', () => {
    captureOnboardingCompleted({ exitPath: 'imported', hadAnyModel: true })

    expect(lastCall()[1]).toMatchObject({
      had_local_model_on_disk: null,
      had_cloud_key: null,
      gate_valid_providers: null,
    })
  })

  it('names the provider a cloud exit was taken through', () => {
    captureOnboardingCompleted({
      exitPath: 'cloud_provider',
      exitProvider: 'chatgpt',
    })

    expect(lastCall()[1]).toMatchObject({
      exit_path: 'cloud_provider',
      exit_provider: 'chatgpt',
    })
  })

  it('reports the step actually reached, not a constant', () => {
    captureOnboardingCompleted({ exitPath: 'timeout', stepReached: 'backend' })

    expect(lastCall()[1]).toMatchObject({ step_reached: 'backend' })
  })
})

describe('abandoned onboarding', () => {
  it('reports a run left behind by a previous launch, once', () => {
    markOnboardingInFlight('backend', Date.now() - 4000)

    reportAbandonedOnboarding()

    const [event, props] = lastCall()
    expect(event).toBe('onboarding_abandoned')
    expect(props).toMatchObject({ step_reached: 'backend' })
    expect(props.started_ago_ms).toBeGreaterThanOrEqual(4000)

    vi.mocked(posthog.capture).mockClear()
    reportAbandonedOnboarding()
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('stays quiet when onboarding finished', () => {
    markOnboardingInFlight('model', Date.now())
    captureOnboardingCompleted({ exitPath: 'imported' })
    vi.mocked(posthog.capture).mockClear()

    reportAbandonedOnboarding()

    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('drops a malformed record instead of reporting nonsense', () => {
    localStorage.setItem(localStorageKey.onboardingInFlight, 'not json')

    reportAbandonedOnboarding()

    expect(posthog.capture).not.toHaveBeenCalled()
    expect(localStorage.getItem(localStorageKey.onboardingInFlight)).toBeNull()
  })
})

describe('setup_local_model_run source split', () => {
  it('separates the scanner from the engine, keeping the old field', () => {
    captureSetupLocalModelRun({ trigger: 'manual', scanSource: 'lmstudio' })
    expect(lastCall()[1]).toMatchObject({
      scan_source: 'lmstudio',
      provider_id: null,
      source: 'lmstudio',
    })

    captureSetupLocalModelRun({
      trigger: 'installed_recommended',
      providerId: 'llamacpp-upstream',
    })
    // Same `source` field, a completely different vocabulary — which is why
    // any breakdown by it mixed scanners with engines.
    expect(lastCall()[1]).toMatchObject({
      scan_source: null,
      provider_id: 'llamacpp-upstream',
      source: 'llamacpp-upstream',
    })
  })
})

describe('picker impressions', () => {
  it('numbers rows the way clicks do, per section', () => {
    const impressions = buildRecommendedImpressions({
      pending: [
        { startId: 'unsloth/gemma', model: { is_mlx: false } },
        { startId: 'mlx-community/qwen', model: { is_mlx: true } },
      ],
      installed: [{ startId: 'already/here', provider: 'mlx' }],
      detected: [{ id: 'on/disk', format: 'gguf' }],
    })

    expect(impressions).toEqual([
      {
        modelId: 'unsloth/gemma',
        position: 0,
        format: 'GGUF',
        section: 'pending',
      },
      {
        modelId: 'mlx-community/qwen',
        position: 1,
        format: 'MLX',
        section: 'pending',
      },
      {
        modelId: 'already/here',
        position: 0,
        format: 'MLX',
        section: 'installed',
      },
      { modelId: 'on/disk', position: 0, format: 'GGUF', section: 'detected' },
    ])
  })

  it('skips a row whose catalog entry has not resolved', () => {
    // It renders as a placeholder with no id, so a click could never be
    // attributed to it either.
    expect(
      buildRecommendedImpressions({
        pending: [{ startId: undefined, model: null }],
        installed: [],
        detected: [],
      })
    ).toEqual([])
  })

  it('emits one event per row so impressions divide by clicks', () => {
    captureRecommendedModelsShown([
      { modelId: 'a\\b', position: 0, format: 'GGUF', section: 'pending' },
      { modelId: 'c/d', position: 1, format: 'MLX', section: 'pending' },
    ])

    const calls = vi.mocked(posthog.capture).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toBe('recommended_model_shown')
    // Same normalization as every other model_id, or the Windows spelling
    // would fail to join with the click.
    expect(calls[0][1]).toMatchObject({ model_id: 'a/b', position: 0 })
  })
})

describe('backend step resolution', () => {
  it('never names a property `status`', () => {
    captureBackendStepResolved({ stepStatus: 'downloaded' })

    const props = lastCall()[1]
    expect(props).toHaveProperty('step_status', 'downloaded')
    // `status` is globally typed numeric in PostHog by
    // `api_server_request.status`; a string written to it reads back as null.
    expect(props).not.toHaveProperty('status')
  })

  it('splits the two values that hid four cases each', () => {
    captureBackendStepResolved({
      stepStatus: 'no_recommendation',
      noRecommendationReason: 'already_optimal',
      currentBackend: 'b9800/win-cuda-13.3-x64',
      durationMs: 1200,
    })

    expect(lastCall()[1]).toMatchObject({
      step_status: 'no_recommendation',
      no_recommendation_reason: 'already_optimal',
      current_backend: 'b9800/win-cuda-13.3-x64',
      duration_ms: 1200,
      replayed: false,
    })
  })

  it('tells a hung detection apart from a broken one', () => {
    expect(
      classifyDetectionFailure(new Error('BACKEND_DETECTION_FAILED'))
    ).toBe('detection_unavailable')
    expect(classifyDetectionFailure(new Error('kaboom'))).toBe('threw')
    expect(classifyDetectionFailure('not an error')).toBe('threw')
  })
})

describe('readRecheckOutcome', () => {
  it('reads the reason the extension recorded', () => {
    expect(
      readRecheckOutcome({ getLastRecheckOutcome: () => 'cpu_optimal' })
    ).toBe('cpu_optimal')
  })

  it('degrades quietly on an older extension that cannot answer', () => {
    expect(readRecheckOutcome({})).toBeNull()
    expect(readRecheckOutcome(undefined)).toBeNull()
    expect(
      readRecheckOutcome({
        getLastRecheckOutcome: () => {
          throw new Error('nope')
        },
      })
    ).toBeNull()
  })
})

describe('restart intent', () => {
  const intent = {
    step_status: 'downloaded' as const,
    recommended_backend: 'b10205/win-cuda-13.3-x64',
    recommended_category: 'CUDA 13',
    current_backend: 'b9800/win-cpu-x64',
    duration_ms: 4200,
  }

  it('reports a resolve the relaunch cut short, marked as replayed', () => {
    markBackendRestartIntent(intent)

    reportBackendRestartIntent()

    const [event, props] = lastCall()
    expect(event).toBe('backend_step_resolved')
    expect(props).toMatchObject({
      step_status: 'downloaded',
      recommended_backend: 'b10205/win-cuda-13.3-x64',
      duration_ms: 4200,
      replayed: true,
    })
  })

  it('reports it once, not on every subsequent launch', () => {
    markBackendRestartIntent(intent)
    reportBackendRestartIntent()
    vi.mocked(posthog.capture).mockClear()

    reportBackendRestartIntent()

    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('stays quiet when the relaunch never happened', () => {
    // The IPC threw, so the component reports the resolve itself and this
    // record must not duplicate it next launch.
    markBackendRestartIntent(intent)
    clearBackendRestartIntent()

    reportBackendRestartIntent()

    expect(posthog.capture).not.toHaveBeenCalled()
  })
})
