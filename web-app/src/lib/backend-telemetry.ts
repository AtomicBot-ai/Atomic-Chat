/**
 * Telemetry for the backend-recommendation surfaces.
 *
 * None of them emitted anything: not the dialog that offers a GPU build,
 * not its "Not now", not the silent upgrade the startup coordinator applies.
 * So "how many Linux hosts were offered Vulkan, and how many took it" had
 * no answer (ATO-464). The onboarding backend step has its own events
 * (`backend_step_*`, ATO-459); these cover the two paths outside it.
 *
 * NOTE: no property here may be named `status`.
 */

import posthog from 'posthog-js'

import { getAnalyticsPlatform } from '@/lib/telemetry'

export type BackendRecommendationTrigger = 'startup' | 'dialog'

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

type RecommendationProps = {
  provider: string
  /** `<tag>/<backend-id>` the host runs now, when known. */
  backendFrom: string | null
  /** `<tag>/<backend-id>` being offered or applied. */
  backendTo: string | null
  trigger: BackendRecommendationTrigger
}

const toProps = (p: RecommendationProps) => ({
  provider: p.provider,
  backend_from: p.backendFrom,
  backend_to: p.backendTo,
  trigger: p.trigger,
})

/** The dialog opened with an offer on it. */
export function captureBackendRecommendationShown(
  p: RecommendationProps
): void {
  capture('backend_recommendation_shown', toProps(p))
}

/** "Not now" — snoozed, not refused forever. */
export function captureBackendRecommendationDismissed(
  p: RecommendationProps & { snoozedForDays: number }
): void {
  capture('backend_recommendation_dismissed', {
    ...toProps(p),
    snoozed_for_days: p.snoozedForDays,
  })
}

/** The download of the offered build started, by hand or on its own. */
export function captureBackendRecommendationApplied(
  p: RecommendationProps
): void {
  capture('backend_recommendation_applied', toProps(p))
}
