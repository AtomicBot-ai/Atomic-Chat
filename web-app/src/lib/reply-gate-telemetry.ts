/**
 * Telemetry for the "what do I reply with?" widget.
 *
 * The path this widget replaced emitted nothing at all: the composer's
 * `!selectedModel` early-return sat in front of `captureChatRequest`, so a user
 * who tried to send a message with no model produced no event anywhere and the
 * size of the problem could only be guessed at. These three events close that:
 * how often the block happens and in what shape (`shown`), what the user did
 * about it (`outcome`), and whether that actually got them a model and how long
 * it took (`ready`).
 *
 * Same PII contract as `lib/telemetry.ts`: enums, ids, counts, booleans.
 *
 * NOTE: no property here may be named `status`. It is typed as a number
 * globally in PostHog, so a string written to it is ingested as null.
 */

import posthog from 'posthog-js'

import { getAnalyticsPlatform } from '@/lib/telemetry'
import type { ReplyGateBranch, ReplyResolution } from '@/lib/reply-model-gate'

/**
 * How the user got out of the widget.
 *
 *  - `auto_start` — the single-model branch started one without asking.
 *  - `picked` — chose one of several already on the device.
 *  - `download` — started downloading the recommendation.
 *  - `folder` — pointed the scanner at a folder of their own, and a model
 *    found there was imported and started.
 *  - `cloud_key` — connected a cloud provider with an API key.
 *  - `subscription` — signed in with a ChatGPT subscription.
 *  - `dismissed` — closed it, still with nothing to answer with.
 */
export type ReplyGateOutcome =
  | 'auto_start'
  | 'picked'
  | 'download'
  | 'folder'
  | 'cloud_key'
  | 'subscription'
  | 'dismissed'

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
 * The widget opened, with the state of the device that decided its shape.
 *
 * This is also the only measure of how often sending is blocked at all — the
 * denominator every other number here is read against.
 */
export function captureReplyGateShown(params: {
  branch: ReplyGateBranch
  localModelCount: number
  cloudProviderCount: number
  hasCloudConnection: boolean
  /** A `HardwareTier` — one of eleven rungs since ATO-463, not the old
   *  two-valued split. Typed loosely so the vocabulary can grow without
   *  touching this module. */
  hardwareTier: string
}): void {
  capture('reply_model_gate_shown', {
    branch: params.branch,
    local_model_count: params.localModelCount,
    cloud_provider_count: params.cloudProviderCount,
    has_cloud_connection: params.hasCloudConnection,
    hardware_tier: params.hardwareTier,
  })
}

/**
 * A send with nothing selected was answered without the widget: the composer
 * resolved a model itself and started it (ATO-461).
 *
 * The sibling of `reply_model_gate_shown`, not a variant of it — the two
 * together are every send that met an empty selection, and their ratio is
 * how often the product could decide for the user versus had to ask.
 */
export function captureReplyModelAutoResolved(params: {
  resolution: ReplyResolution
  localModelCount: number
  cloudProviderCount: number
  hasCloudConnection: boolean
  hardwareTier: string
}): void {
  capture('reply_model_auto_resolved', {
    resolution: params.resolution,
    local_model_count: params.localModelCount,
    cloud_provider_count: params.cloudProviderCount,
    has_cloud_connection: params.hasCloudConnection,
    hardware_tier: params.hardwareTier,
  })
}

/**
 * The exit the user took, and how long they spent deciding.
 *
 * Fires once per opening — including `dismissed`, which is the one outcome the
 * old red line produced and the one this widget exists to shrink.
 */
export function captureReplyGateOutcome(params: {
  branch: ReplyGateBranch
  outcome: ReplyGateOutcome
  /** Widget open → decision. */
  decidedInMs: number
}): void {
  capture('reply_model_gate_outcome', {
    branch: params.branch,
    outcome: params.outcome,
    decided_in_ms: Math.max(0, Math.round(params.decidedInMs)),
  })
}

/**
 * A model actually became answerable after the widget resolved.
 *
 * Separate from the outcome event because the two can be far apart — a 2 GB
 * download is minutes, an already-downloaded model is seconds — and because
 * the gap between "chose an exit" and "got a model" is exactly the drop-off
 * this feature has to be judged on. `queued_message_sent` says whether the
 * message the user had already typed went out on its own, which is the promise
 * the widget makes.
 */
export function captureReplyGateReady(params: {
  branch: ReplyGateBranch
  outcome: ReplyGateOutcome
  /** Widget open (or silent resolution) → model ready to answer. */
  readyInMs: number
  queuedMessageSent: boolean
  /** Set when the composer resolved the model itself, without the widget. */
  resolution?: ReplyResolution
}): void {
  capture('reply_model_gate_ready', {
    branch: params.branch,
    outcome: params.outcome,
    ready_in_ms: Math.max(0, Math.round(params.readyInMs)),
    queued_message_sent: params.queuedMessageSent,
    resolution: params.resolution ?? null,
  })
}
