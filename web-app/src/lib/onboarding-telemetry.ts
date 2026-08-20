/**
 * Onboarding-funnel telemetry.
 *
 * The existing events (`setup_screen_shown`, `recommended_model_clicked`,
 * `setup_local_model_autostarted`, `setup_skipped`, `backend_step_resolved`)
 * covered the middle of the flow but left both ends dark: there was no way to
 * tell a completed onboarding from an abandoned one, and three of the four exit
 * paths emitted nothing at all. This module adds the missing events.
 *
 * Every emitter takes plain values and does its own defaulting, because the two
 * call sites — `SetupScreen.tsx` and `SetupBackendStep.tsx` — sit under
 * coverage floors in `tests/coverage-floor.json` (the backend step's branch
 * floor is 100 %). Keeping the `??` here means the call sites stay
 * branch-free single calls.
 *
 * Same PII contract as `lib/telemetry.ts`: enums, ids, numbers, booleans.
 */

import posthog from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'
import { getAnalyticsPlatform } from '@/lib/telemetry'

/**
 * Whether this looks like the very first launch on this device.
 *
 * Derived from persisted state rather than a launch counter, so it is also
 * correct for users who upgraded from a build that never wrote one: both
 * markers are set the first time the app is used at all — `setup-completed` by
 * any exit from onboarding, `last-seen-version` by the What's New check.
 */
export function isFirstLaunch(): boolean {
  if (typeof window === 'undefined') return false
  return (
    localStorage.getItem(localStorageKey.setupCompleted) === null &&
    localStorage.getItem(localStorageKey.lastSeenVersion) === null
  )
}

/** How the user left onboarding. Mutually exclusive and single-fire — the
 * `hasNavigatedRef` guard in `SetupScreen` makes all five paths exclusive. */
export type OnboardingExitPath =
  /** Picked a model already on disk; it was imported and launched. */
  | 'imported'
  /** Started a download and entered the chat while it ran. */
  | 'download_started'
  /** Connected a cloud provider's API key instead of a local model. */
  | 'cloud_provider'
  /** Pressed Skip. No longer emitted — the link was removed from the model
   *  step — but kept so historical events stay typed. */
  | 'skipped'
  /** The 15s auto-exit fired with the picker untouched. */
  | 'timeout'

function capture(event: string, props: Record<string, unknown>): void {
  try {
    posthog.capture(event, {
      ...props,
      platform: getAnalyticsPlatform(),
      app_version: VERSION,
    })
  } catch (err) {
    console.debug(`${event} telemetry failed:`, err)
  }
}

/**
 * The one event that says onboarding ended, and how. Without it, completion
 * could only be inferred from a later `model_load` / `thread_created`, which
 * cannot distinguish "finished setup" from "gave up and left".
 */
export function captureOnboardingCompleted(params: {
  exitPath: OnboardingExitPath
  hadAnyModel?: boolean
  stepReached?: string
  startedAtMs?: number | null
}): void {
  capture('onboarding_completed', {
    exit_path: params.exitPath,
    had_any_model: params.hadAnyModel ?? false,
    step_reached: params.stepReached ?? 'model',
    duration_ms:
      params.startedAtMs != null
        ? Math.max(0, Date.now() - params.startedAtMs)
        : null,
  })
}

/**
 * A model already on disk was launched by hand. The auto-start path has had
 * `setup_local_model_autostarted` since the beginning; the two manual paths
 * (the detected-models list and Run on an already-installed recommendation)
 * were the only untracked *successful* way out of the picker.
 *
 * Kept as a separate event rather than folded into
 * `setup_local_model_autostarted` so existing dashboards keep their meaning.
 */
export function captureSetupLocalModelRun(params: {
  trigger: 'manual' | 'installed_recommended'
  source?: string | null
  format?: string | null
  sizeBytes?: number | null
  detectedCount?: number | null
}): void {
  capture('setup_local_model_run', {
    trigger: params.trigger,
    source: params.source ?? null,
    format: params.format ?? null,
    size_gb: params.sizeBytes
      ? Math.round((params.sizeBytes / 1024 ** 3) * 100) / 100
      : null,
    detected_count: params.detectedCount ?? null,
  })
}

/**
 * Entry into the Windows-only GPU backend step. Only `backend_step_resolved`
 * existed, so a user who quit during GPU detection was invisible: pairing this
 * with the resolve event gives the step's drop-off rate.
 *
 * Takes no arguments on purpose — the call site lives in a file with a 100 %
 * branch-coverage floor, so it must stay a single unconditional call. Nothing
 * useful is known at mount anyway: detection has not run yet.
 */
export function captureBackendStepShown(): void {
  capture('backend_step_shown', { phase: 'detecting' })
}

/** The model picker screen. `rendered: false` means an auto-start pre-empted
 * it, which previously dropped those sessions out of the funnel entirely. */
export function captureSetupScreenShown(params: {
  recommendedCount?: number | null
  rendered: boolean
  /** Which recommendation list was shown — see `classifyHardwareTier`. */
  hardwareTier?: 'low' | 'standard'
  /** False when the tier deadline elapsed and 'standard' was assumed. */
  hardwareTierResolved?: boolean
}): void {
  capture('setup_screen_shown', {
    recommended_count: params.recommendedCount ?? 0,
    rendered: params.rendered,
    hardware_tier: params.hardwareTier ?? null,
    hardware_tier_resolved: params.hardwareTierResolved ?? null,
  })
}

/** The post-onboarding "you have no model" nudge, previously untracked. */
export function captureOnboardingModelReminder(
  action: 'shown' | 'download' | 'later'
): void {
  capture('onboarding_model_reminder', { action })
}

/**
 * A remote provider gained an API key. Doing this satisfies the onboarding
 * gate, so it is a real exit from the flow that used to bypass all telemetry.
 */
export function captureProviderKeyConfigured(params: {
  provider: string
  duringOnboarding: boolean
}): void {
  capture('provider_key_configured', {
    provider: params.provider,
    during_onboarding: params.duringOnboarding,
  })
}
