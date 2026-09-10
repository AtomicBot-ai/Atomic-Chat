/**
 * Subscription sign-in telemetry (ATO-456).
 *
 * The ChatGPT subscription shipped with no instrumentation at all: a `grep`
 * for `posthog.capture` across the hook, the cloud containers, the auth
 * service and the cloud route returned nothing. `provider_key_configured`
 * cannot cover it either — that fires from `saveProviderApiKey`, and a
 * provider with no `api-key` setting never goes through it. So the number of
 * people who connected a subscription was zero observations, not zero
 * connections, and the two are very different things.
 *
 * Same PII contract as `lib/telemetry.ts`: enums, ids, numbers, booleans. The
 * account's email never leaves the renderer; only `plan_type` does.
 */

import { getAnalyticsPlatform } from '@/lib/telemetry'
import { queuedCapture } from '@/lib/telemetry-queue'

/**
 * Where the card the user acted on was rendered.
 *
 * A new convention — the codebase had `during_onboarding`, `trigger` and two
 * different `source`s, none of which answer "which screen was this". Reaching
 * the subscription used to mean navigating to /cloud and finding it there, so
 * whether a surface converts is the question this feature exists to answer.
 */
export type SubscriptionSurface = 'onboarding' | 'settings' | 'chat_widget'

/**
 * How a connect attempt ended.
 *
 * NOT named `status`: PostHog typed that property numeric project-wide from
 * `api_server_request.status`, and strings written to it read back as null.
 */
export type SubscriptionConnectResult = 'connected' | 'cancelled' | 'failed'

function capture(event: string, props: Record<string, unknown>): void {
  queuedCapture(event, {
    ...props,
    platform: getAnalyticsPlatform(),
    app_version: VERSION,
  })
}

/** The subscription card was rendered. The denominator for everything else. */
export function captureSubscriptionCardShown(params: {
  provider: string
  surface: SubscriptionSurface
}): void {
  capture('subscription_card_shown', {
    provider: params.provider,
    surface: params.surface,
  })
}

/** The user asked to sign in and the browser was handed the OAuth URL. */
export function captureSubscriptionConnectStarted(params: {
  provider: string
  surface: SubscriptionSurface
}): void {
  capture('subscription_connect_started', {
    provider: params.provider,
    surface: params.surface,
  })
}

/**
 * The attempt ended.
 *
 * `duration_ms` covers the whole round trip through the browser, so it is
 * dominated by how long the user took — which is the interesting part, since
 * the flow's 300s callback timeout is one of the failure modes.
 */
export function captureSubscriptionConnectResult(params: {
  provider: string
  surface: SubscriptionSurface
  connectResult: SubscriptionConnectResult
  failureReason?: string | null
  planType?: string | null
  modelCount?: number | null
  durationMs?: number | null
}): void {
  capture('subscription_connect_result', {
    provider: params.provider,
    surface: params.surface,
    connect_result: params.connectResult,
    failure_reason: params.failureReason ?? null,
    plan_type: params.planType ?? null,
    model_count: params.modelCount ?? null,
    duration_ms: params.durationMs ?? null,
  })
}

/** The user signed out of the subscription. */
export function captureSubscriptionDisconnected(params: {
  provider: string
  surface: SubscriptionSurface
}): void {
  capture('subscription_disconnected', {
    provider: params.provider,
    surface: params.surface,
  })
}
