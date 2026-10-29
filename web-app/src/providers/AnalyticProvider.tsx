import posthog from 'posthog-js'
import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useAnalytic } from '@/hooks/useAnalytic'
import {
  API_SERVER_REQUEST_EVENT,
  API_SERVER_SESSION_SUMMARY_EVENT,
  type ApiServerRequestEvent,
  type ApiServerSessionSummaryEvent,
} from '@/types/analytics'
import type { ServiceHub } from '@/services'
import { getAnalyticsPlatform } from '@/lib/telemetry'
import { collectHardwareSuperProps, withTimeout } from '@/lib/hardware-summary'
import {
  isFirstLaunch,
  reportAbandonedOnboarding,
  reportBackendRestartIntent,
} from '@/lib/onboarding-telemetry'
import {
  bufferTelemetryUntilReady,
  disableTelemetryQueue,
  flushTelemetryQueue,
} from '@/lib/telemetry-queue'
import { restoreInstallDistinctId } from '@/lib/telemetry-identity'
import {
  captureOnboardingCohort,
  registerOnboardingCohort,
} from '@/lib/onboarding/experiment'
import {
  setSentryConsent,
  setSentryTags,
  setSentryUser,
  setRustSentryContext,
  setRustSentryUser,
} from '@/lib/sentry'

/** Zero-PII hardware/backend super-props promoted to Sentry tags. */
const SENTRY_TAG_KEYS = [
  'os',
  'os_build',
  'arch',
  'cpu_avx',
  'gpu_vendor',
  'gpu_model',
  'vram_mb',
  'system_ram_mb',
  'nvidia_driver_version',
  'cuda_runtime_version',
  'vulkan_version',
  'active_backend',
  'device_backend_pref',
  'recommended_backend',
  'installer_type',
] as const

function toSentryTags(
  hwProps: Record<string, unknown>,
  appVersion: string,
  platform: string
): Record<string, string> {
  const tags: Record<string, string> = {
    app_version: appVersion,
    platform,
  }
  for (const key of SENTRY_TAG_KEYS) {
    const value = hwProps[key]
    if (value !== undefined && value !== null && value !== '') {
      tags[key] = String(value)
    }
  }
  return tags
}

/**
 * Version of the event schema this build emits.
 *
 * Bumped whenever event shapes change, so analysis can cut a denominator on one
 * number instead of guessing which app version first carried a property.
 * `rendered` and `hardware_tier` arriving in 2.0.19 is what made that guessing
 * necessary — 73% of historical events simply do not have them.
 *
 * 2 — ATO-457/459/456/468: startup event buffering, normalized `model_id`,
 * split onboarding / backend-step reasons, subscription events.
 * 3 — explicit startup readiness and recoverable cohort assignment capture.
 */
const TELEMETRY_SCHEMA = 3

/**
 * ATO-111: `device_parse_ok` reflects whether `llama-server --list-devices`
 * could be parsed (the `DeviceListParseFailed` flag). The probe spawns the
 * backend binary and can be slow, so it runs detached from `app_opened`.
 */
async function collectDeviceParseOk(
  serviceHub: ServiceHub
): Promise<boolean | undefined> {
  if (typeof IS_TAURI === 'undefined' || !IS_TAURI) return undefined
  try {
    await withTimeout(serviceHub.hardware().getLlamacppDevices(), 8000)
    return true
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    const message = (
      (error as { message?: string } | undefined)?.message ?? ''
    ).toLowerCase()
    if (
      code === 'DEVICE_LIST_PARSE_FAILED' ||
      code === 'DeviceListParseFailed' ||
      message.includes('available devices')
    )
      return false
    return undefined
  }
}

export function AnalyticProvider() {
  const { productAnalytic } = useAnalytic()
  const serviceHub = useServiceHub()

  // ATO-113: keep both Sentry SDKs (frontend gate + Rust gate) in sync with the
  // productAnalytic consent. Runs independently of PostHog config so consent is
  // honoured even when PostHog keys are absent.
  useEffect(() => {
    setSentryConsent(productAnalytic)
  }, [productAnalytic])

  useEffect(() => {
    if (!POSTHOG_KEY || !POSTHOG_HOST) {
      disableTelemetryQueue()
      console.warn(
        'PostHog not initialized: Missing POSTHOG_KEY or POSTHOG_HOST environment variables'
      )
      return
    }

    let unlistenApiServerRequest: (() => void) | undefined
    let unlistenApiServerSummary: (() => void) | undefined
    let cancelled = false

    const osPlatform = getAnalyticsPlatform()

    if (productAnalytic) {
      bufferTelemetryUntilReady()
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        person_profiles: 'always',
        persistence: 'localStorage',
        opt_out_capturing_by_default: true,

        sanitize_properties: function (properties) {
          const denylist = [
            '$pathname',
            '$initial_pathname',
            '$current_url',
            '$initial_current_url',
            '$host',
            '$initial_host',
            '$initial_person_info',
          ]

          denylist.forEach((key) => {
            if (properties[key]) {
              properties[key] = null
            }
          })

          return properties
        },
      })
      // Register platform/version immediately so they attach to every event,
      // including any that fire before the async chain below resolves.
      posthog.register({
        app_version: VERSION,
        platform: osPlatform,
        telemetry_schema: TELEMETRY_SCHEMA,
      })
      restoreInstallDistinctId(serviceHub.analytic())
        .catch((err) => {
          console.warn('Failed to restore the analytics distinct id:', err)
        })
        .finally(async () => {
          if (cancelled) return
          posthog.opt_in_capturing()
          posthog.register({
            app_version: VERSION,
            platform: osPlatform,
            telemetry_schema: TELEMETRY_SCHEMA,
          })
          // The onboarding experiment's cohort, on the person and on every
          // event from here on, the replayed startup events included.
          registerOnboardingCohort(posthog)

          // ATO-111: register hardware/OS/backend super-properties BEFORE
          // app_opened so they attach to it and every subsequent event. Bounded
          // by internal timeouts; failures degrade to fewer properties.
          try {
            const hwProps = await collectHardwareSuperProps(serviceHub)
            if (Object.keys(hwProps).length > 0) posthog.register(hwProps)

            // ATO-113: promote the same zero-PII hardware/backend context to
            // Sentry (frontend tags + Rust scope) and set the anonymous device
            // id as the Sentry user.
            const sentryTags = toSentryTags(hwProps, VERSION, osPlatform)
            setSentryTags(sentryTags)
            setRustSentryContext(sentryTags)
            setSentryUser(posthog.get_distinct_id())
            setRustSentryUser(posthog.get_distinct_id())
          } catch (err) {
            console.warn('Failed to collect hardware super-properties:', err)
          }

          if (cancelled) return

          // The assignment is persisted before React mounts. Send it under
          // the restored identity, at its original time, including on upgrades
          // from builds that lost it before PostHog was initialized.
          captureOnboardingCohort(posthog)

          // Everything captured during startup was held back, because
          // `opt_out_capturing_by_default` makes posthog-js drop rather than
          // buffer. Replay it now: after the super-properties so replayed
          // events carry them. A cancelled initialization leaves the queue for
          // the active effect; it must not flush after consent was withdrawn.
          flushTelemetryQueue()

          // An onboarding run left on screen when the app closed. Reported
          // here rather than from a close handler, which the renderer is not
          // reliably given.
          reportAbandonedOnboarding()
          // A backend step whose resolve was cut short by "Restart now".
          reportBackendRestartIntent()

          if (cancelled) return

          // Pass platform/version explicitly too, so the funnel's first event
          // carries them even if super-prop merging races on this capture.
          posthog.capture('app_opened', {
            platform: osPlatform,
            app_version: VERSION,
            // Lets the onboarding funnel be filtered to genuine first sessions.
            // Derived from persisted state rather than a counter so it stays
            // correct for users who upgraded from a build without it.
            is_first_launch: isFirstLaunch(),
          })

          // Detached: the device-list probe spawns the backend and can be slow,
          // so it must never delay app_opened. It attaches to later events.
          void collectDeviceParseOk(serviceHub).then((value) => {
            if (value !== undefined && !cancelled)
              posthog.register({ device_parse_ok: value })
          })

          // Forward Local API Server proxy telemetry emitted by the Rust
          // backend. Loaded dynamically so the web-app build stays usable in
          // non-Tauri environments. PostHog consent is already enforced via
          // `opt_in_capturing`; the extra `productAnalytic` guard is defensive
          // in case the provider effect reruns after toggling the setting.
          if (IS_TAURI) {
            import('@tauri-apps/api/event')
              .then(({ listen }) =>
                Promise.all([
                  listen<ApiServerRequestEvent>(
                    API_SERVER_REQUEST_EVENT,
                    (evt) => {
                      if (!productAnalytic) return
                      posthog.capture('api_server_request', evt.payload)
                    }
                  ),
                  listen<ApiServerSessionSummaryEvent>(
                    API_SERVER_SESSION_SUMMARY_EVENT,
                    (evt) => {
                      if (!productAnalytic) return
                      posthog.capture('api_server_session_summary', evt.payload)
                    }
                  ),
                ])
              )
              .then(([unlistenRequest, unlistenSummary]) => {
                const detachRequest = createSafeUnlisten(unlistenRequest)
                const detachSummary = createSafeUnlisten(unlistenSummary)
                if (cancelled) {
                  void detachRequest()
                  void detachSummary()
                } else {
                  unlistenApiServerRequest = detachRequest
                  unlistenApiServerSummary = detachSummary
                }
              })
              .catch((err) => {
                console.warn(
                  'Failed to register API server analytics listeners:',
                  err
                )
              })
          }
        })
    } else {
      disableTelemetryQueue()
      posthog.opt_out_capturing()
    }

    return () => {
      cancelled = true
      void unlistenApiServerRequest?.()
      void unlistenApiServerSummary?.()
    }
  }, [productAnalytic, serviceHub])

  return null
}
