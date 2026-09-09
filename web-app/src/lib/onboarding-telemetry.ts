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

import { localStorageKey } from '@/constants/localStorage'
import { getAnalyticsPlatform, normalizeModelId } from '@/lib/telemetry'
import { queuedCapture } from '@/lib/telemetry-queue'

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
 * `hasNavigatedRef` guard in `SetupScreen` makes all paths exclusive. */
export type OnboardingExitPath =
  /** Picked a model already on disk; it was imported and launched. */
  | 'imported'
  /** Started a download and entered the chat while it ran. */
  | 'download_started'
  /** Connected a cloud provider's API key or subscription instead. */
  | 'cloud_provider'
  /**
   * The user pressed Skip and entered the chat empty-handed. The composer's
   * "what do I reply with?" widget picks it up from there (ATO-453).
   */
  | 'dismissed'
  /**
   * Legacy: the 15s auto-exit fired with the picker untouched. No longer
   * emitted — the timeout was removed in ATO-454 after it turned out to be 60 %
   * of all onboarding exits, at a 16.2 s median, i.e. people were sitting there
   * waiting for it. Kept in the union so historical queries still type-check.
   */
  | 'timeout'

/**
 * Which screen of onboarding the user got to.
 *
 * `backend` is Windows-only and comes first. It was unreachable in telemetry
 * until now: `step_reached` was the literal `'model'` at all four exit sites,
 * and a user who quit on the backend step emitted no exit event at all.
 */
export type OnboardingStep = 'backend' | 'model'

/** Shape of `describeProviderState`, kept structural so this module does not
 *  have to import the provider store. */
export type ProviderStateForTelemetry = {
  hadLocalModelOnDisk: boolean
  hadCloudKey: boolean
  gateValidProviders: boolean
}

function providerStateProps(
  state?: ProviderStateForTelemetry
): Record<string, boolean | null> {
  return {
    had_local_model_on_disk: state?.hadLocalModelOnDisk ?? null,
    had_cloud_key: state?.hadCloudKey ?? null,
    gate_valid_providers: state?.gateValidProviders ?? null,
  }
}

/** Round bytes to two decimal GB. Coarse on purpose — an exact byte count is
 *  a fingerprint, and nothing here needs that precision. */
function gbFromBytes(bytes?: number | null): number | null {
  return bytes ? Math.round((bytes / 1024 ** 3) * 100) / 100 : null
}

function capture(event: string, props: Record<string, unknown>): void {
  queuedCapture(event, {
    ...props,
    platform: getAnalyticsPlatform(),
    app_version: VERSION,
  })
}

/**
 * The one event that says onboarding ended, and how. Without it, completion
 * could only be inferred from a later `model_load` / `thread_created`, which
 * cannot distinguish "finished setup" from "gave up and left".
 */
export function captureOnboardingCompleted(params: {
  exitPath: OnboardingExitPath
  /**
   * Legacy. Means "the picker had something to show", not "a model exists" —
   * kept unchanged so its historical series stays comparable. Read the three
   * fields below instead; see `describeProviderState`.
   */
  hadAnyModel?: boolean
  providerState?: ProviderStateForTelemetry
  /** Which cloud provider was connected, on the `cloud_provider` path. Without
   *  it a ChatGPT subscription is indistinguishable from a pasted API key. */
  exitProvider?: string | null
  stepReached?: OnboardingStep
  startedAtMs?: number | null
}): void {
  // The run finished, so the record that would otherwise report it as
  // abandoned on the next launch has to go. Done here rather than at the four
  // exit sites so a new exit path cannot forget it.
  try {
    localStorage.removeItem(localStorageKey.onboardingInFlight)
  } catch {
    // localStorage unavailable — worst case one spurious abandonment event.
  }
  capture('onboarding_completed', {
    exit_path: params.exitPath,
    had_any_model: params.hadAnyModel ?? false,
    ...providerStateProps(params.providerState),
    exit_provider: params.exitProvider ?? null,
    step_reached: params.stepReached ?? 'model',
    duration_ms:
      params.startedAtMs != null
        ? Math.max(0, Date.now() - params.startedAtMs)
        : null,
  })
}

/**
 * Onboarding that never ended: the app was closed while it was still on
 * screen. Reported on the next launch from a record `SetupScreen` keeps while
 * it is mounted, because a window close is not a moment the renderer can rely
 * on being given.
 *
 * A separate event rather than a late `onboarding_completed` on purpose: the
 * duration would be measured across a process boundary, and a completion event
 * arriving after the next launch's `app_opened` would corrupt funnel ordering.
 * Queries that want "left onboarding, however" union the two.
 *
 * Note there is no duration: nothing observes the moment the app went away, so
 * how long the user actually sat there is genuinely unknown. `started_ago_ms`
 * says when the abandoned run *began*, which at least separates "closed it
 * seconds ago and came straight back" from "gave up a week ago".
 */
export function captureOnboardingAbandoned(params: {
  stepReached: OnboardingStep
  /** App version that was running then — not necessarily this one, since the
   *  user may have updated in between. */
  abandonedAppVersion?: string | null
  startedAtMs?: number | null
}): void {
  capture('onboarding_abandoned', {
    step_reached: params.stepReached,
    abandoned_app_version: params.abandonedAppVersion ?? null,
    started_ago_ms:
      params.startedAtMs != null
        ? Math.max(0, Date.now() - params.startedAtMs)
        : null,
  })
}

/**
 * Record of an onboarding run that is currently on screen.
 *
 * Written while the flow is open and dropped by `captureOnboardingCompleted`,
 * so anything left behind at the next launch is by definition a run that was
 * never finished.
 */
export type OnboardingInFlight = {
  started_at: number
  step: OnboardingStep
  app_version: string
}

export function markOnboardingInFlight(
  step: OnboardingStep,
  startedAt: number
): void {
  try {
    localStorage.setItem(
      localStorageKey.onboardingInFlight,
      JSON.stringify({
        started_at: startedAt,
        step,
        app_version: VERSION,
      } satisfies OnboardingInFlight)
    )
  } catch {
    // localStorage unavailable — the run simply goes unreported.
  }
}

/**
 * Report and clear an unfinished run from a previous launch, if there is one.
 * Called once per launch, after consent has been applied.
 */
export function reportAbandonedOnboarding(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(localStorageKey.onboardingInFlight)
    if (raw) localStorage.removeItem(localStorageKey.onboardingInFlight)
  } catch {
    return
  }
  if (!raw) return
  try {
    const record = JSON.parse(raw) as Partial<OnboardingInFlight>
    captureOnboardingAbandoned({
      stepReached: record.step === 'backend' ? 'backend' : 'model',
      abandonedAppVersion: record.app_version ?? null,
      startedAtMs:
        typeof record.started_at === 'number' ? record.started_at : null,
    })
  } catch {
    // malformed record — nothing worth reporting
  }
}

/** The empty-handed exit. Superseded by `onboarding_completed` with the same
 *  `exit_path`, kept so its dashboard series does not break.
 *
 *  `reason` moved from `'timeout'` to `'dismissed'` rather than reusing either
 *  that value or the older `'skipped'`: the two are different user acts —
 *  running out the clock and pressing a button — and a series that silently
 *  changes meaning is worse than one that visibly splits. */
export function captureSetupSkipped(params: {
  hadAnyModel: boolean
  reason: 'dismissed'
}): void {
  capture('setup_skipped', {
    had_any_model: params.hadAnyModel,
    reason: params.reason,
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
  /** Which scanner found the file: lmstudio / huggingface-cache / unsloth /
   *  ollama / local. Only the `manual` path knows this. */
  scanSource?: string | null
  /** Engine the model is registered under: llamacpp / llamacpp-upstream / mlx.
   *  Only the `installed_recommended` path knows this. */
  providerId?: string | null
  format?: string | null
  sizeBytes?: number | null
  detectedCount?: number | null
}): void {
  capture('setup_local_model_run', {
    trigger: params.trigger,
    scan_source: params.scanSource ?? null,
    provider_id: params.providerId ?? null,
    // Legacy: one field carrying two unrelated vocabularies depending on
    // `trigger`, so any breakdown by it mixed scanners with engines. The two
    // fields above are the ones to group on.
    source: params.scanSource ?? params.providerId ?? null,
    format: params.format ?? null,
    size_gb: gbFromBytes(params.sizeBytes),
    detected_count: params.detectedCount ?? null,
  })
}

/**
 * A model already on disk was launched without the user choosing it, because
 * it was the only sensible candidate. Was emitted inline with a raw capture;
 * moved here so it carries `scan_source` like its two siblings.
 */
export function captureSetupLocalModelAutostarted(params: {
  scanSource?: string | null
  format?: string | null
  sizeBytes?: number | null
  detectedCount?: number | null
}): void {
  capture('setup_local_model_autostarted', {
    scan_source: params.scanSource ?? null,
    source: params.scanSource ?? null,
    format: params.format ?? null,
    size_gb: gbFromBytes(params.sizeBytes),
    detected_count: params.detectedCount ?? null,
  })
}

/** One row of the first-run picker. */
export type RecommendedModelImpression = {
  modelId: string
  /** Index within the row's own section, matching the `position` that
   *  `recommended_model_clicked` reports, so the two divide directly. */
  position: number
  /** Upper-case to match `recommended_model_clicked.format`. The older
   *  `setup_local_model_run.format` is lower-case; do not mix them. */
  format: 'GGUF' | 'MLX' | null
  /** Which list the row was in: a download suggestion, an already-installed
   *  recommendation, or a model the scanners found on disk. */
  section: 'pending' | 'installed' | 'detected'
}

/**
 * Flatten the picker's three lists into one impression per visible row.
 *
 * Lives here rather than in `SetupScreen` because that file sits under a
 * branch-coverage floor: the call site has to stay a single unconditional
 * call, so all the `??`s belong on this side.
 */
export function buildRecommendedImpressions(lists: {
  pending: { startId?: string | null; model?: { is_mlx?: boolean } | null }[]
  installed?: { startId: string; provider: string }[]
  detected?: { id: string; format: string }[]
}): RecommendedModelImpression[] {
  const impressions: RecommendedModelImpression[] = []

  lists.pending.forEach((row, position) => {
    // A row whose catalog entry has not resolved yet renders as a placeholder
    // and has no id to attribute a click to.
    if (!row.startId) return
    impressions.push({
      modelId: row.startId,
      position,
      format: row.model?.is_mlx ? 'MLX' : 'GGUF',
      section: 'pending',
    })
  })
  ;(lists.installed ?? []).forEach((row, position) => {
    impressions.push({
      modelId: row.startId,
      position,
      format: row.provider === 'mlx' ? 'MLX' : 'GGUF',
      section: 'installed',
    })
  })
  ;(lists.detected ?? []).forEach((row, position) => {
    impressions.push({
      modelId: row.id,
      position,
      format: row.format === 'mlx' ? 'MLX' : 'GGUF',
      section: 'detected',
    })
  })

  return impressions
}

/**
 * Every row the picker actually put in front of the user.
 *
 * Clicks have always been tracked with a `position`; impressions never were, so
 * a row's conversion — and whether the list is read at all past the first
 * entry — could not be computed. Emitted per row rather than as one array
 * event so it divides directly by `recommended_model_clicked`.
 *
 * Called more than once per screen since the picker gained its disclosure: the
 * rows behind "other options" have not been shown to anybody until it is
 * opened, and counting them at paint would put a denominator under rows nobody
 * saw — exactly the miscount this event was added to fix.
 */
export function captureRecommendedModelsShown(
  items: RecommendedModelImpression[]
): void {
  for (const item of items) {
    capture('recommended_model_shown', {
      model_id: normalizeModelId(item.modelId),
      position: item.position,
      format: item.format,
      section: item.section,
    })
  }
}

/** A row of the picker was clicked, before any download starts. */
export function captureRecommendedModelClicked(params: {
  modelId: string
  format: 'GGUF' | 'MLX'
  sizeGb?: number
  position: number
}): void {
  capture('recommended_model_clicked', {
    model_id: normalizeModelId(params.modelId),
    size_gb: params.sizeGb ?? null,
    format: params.format,
    position: params.position,
  })
}

/**
 * Outcome of the Windows-only GPU-backend step.
 *
 * `no_recommendation` and `detection_failed` each hide several unrelated
 * cases, which is why "46% of users who reach the step get one of them" could
 * not be read as a problem: `already_optimal` is the healthy outcome and is
 * probably the most common one. The two `*_reason` properties below split
 * them; these values stay as they are so the existing series survives.
 */
export type BackendStepStatus =
  | 'downloaded'
  | 'cpu'
  | 'skipped'
  | 'no_recommendation'
  | 'detection_failed'

/** Why detection produced nothing usable. */
export type BackendDetectionFailure =
  /** The llama.cpp extension was not registered in this build. */
  | 'no_extension'
  /** The extension's own sentinel: release stream unreachable, hardware probe
   *  threw, or the lookup timed out. Not the same as "CPU is best". */
  | 'detection_unavailable'
  /** Anything else the call threw. */
  | 'threw'
  /** Never left the spinner inside the watchdog window. */
  | 'watchdog'

const BACKEND_DETECTION_FAILED = 'BACKEND_DETECTION_FAILED'

/**
 * Classify a thrown detection error.
 *
 * Lives here, not in `SetupBackendStep`, because that component is a shell
 * whose branch-coverage floor is satisfied by never executing: the moment a
 * conditional lands in it, it has to be exercised or the floor breaks. So the
 * call site stays `ref.current = classifyDetectionFailure(err)`.
 */
export function classifyDetectionFailure(
  err: unknown
): BackendDetectionFailure {
  if (err instanceof Error && err.message === BACKEND_DETECTION_FAILED) {
    return 'detection_unavailable'
  }
  return 'threw'
}

/**
 * Why `recheckOptimalBackend()` returned nothing, read from the extension.
 *
 * The method returns `null` for four unrelated reasons and the return type
 * cannot say which — it has three callers and is not worth breaking for
 * telemetry, so the extension records the reason and this reads it back.
 * Optional-called, so a build carrying an older extension degrades to `null`
 * rather than throwing.
 */
export function readRecheckOutcome(ext: unknown): string | null {
  try {
    const getter = (ext as { getLastRecheckOutcome?: () => string | null })
      ?.getLastRecheckOutcome
    return typeof getter === 'function' ? (getter.call(ext) ?? null) : null
  } catch {
    return null
  }
}

/**
 * The backend step ended. Was emitted inline; moved here so the reason splits
 * and the duration have somewhere to live that is actually tested.
 */
export function captureBackendStepResolved(params: {
  stepStatus: BackendStepStatus
  recommendedBackend?: string | null
  recommendedCategory?: string | null
  /** What the device was already running, so `already_optimal` can be told
   *  apart from "we had nothing to offer this machine". */
  currentBackend?: string | null
  detectionFailureReason?: BackendDetectionFailure | null
  noRecommendationReason?: string | null
  /** Mount to resolve. Answers how many people sit out the 30s watchdog. */
  durationMs?: number | null
  /** Replayed from a previous launch: the app relaunched before it could be
   *  sent. See `markBackendRestartIntent`. */
  replayed?: boolean
}): void {
  capture('backend_step_resolved', {
    // NOT `status` — globally typed numeric in PostHog by
    // `api_server_request.status`, which is why this tile read empty and was
    // written off as an instrumentation bug for six weeks.
    step_status: params.stepStatus,
    recommended_backend: params.recommendedBackend ?? null,
    recommended_category: params.recommendedCategory ?? null,
    current_backend: params.currentBackend ?? null,
    detection_failure_reason: params.detectionFailureReason ?? null,
    no_recommendation_reason: params.noRecommendationReason ?? null,
    duration_ms: params.durationMs ?? null,
    replayed: params.replayed ?? false,
  })
}

/** What a pending restart owes the next launch. */
export type BackendRestartIntent = {
  step_status: BackendStepStatus
  recommended_backend: string | null
  recommended_category: string | null
  current_backend: string | null
  duration_ms: number | null
}

/**
 * Record a resolve that is about to be cut short by a relaunch.
 *
 * "Restart now" kills the process before `finish` runs, so the success path
 * emitted nothing and only the `catch` — a *failed* relaunch — ever reported.
 * In the data that reads as "restarting always fails", when in fact those were
 * the only restarts anyone could see.
 */
export function markBackendRestartIntent(intent: BackendRestartIntent): void {
  try {
    localStorage.setItem(
      localStorageKey.backendStepRestartIntent,
      JSON.stringify(intent)
    )
  } catch {
    // localStorage unavailable — the restart simply goes unreported.
  }
}

/** Drop a pending intent — the relaunch it was written for did not happen. */
export function clearBackendRestartIntent(): void {
  try {
    localStorage.removeItem(localStorageKey.backendStepRestartIntent)
  } catch {
    // localStorage unavailable — worst case one duplicated resolve event.
  }
}

/** Send and clear a restart intent left by the previous launch, if any. */
export function reportBackendRestartIntent(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(localStorageKey.backendStepRestartIntent)
    if (raw) localStorage.removeItem(localStorageKey.backendStepRestartIntent)
  } catch {
    return
  }
  if (!raw) return
  try {
    const intent = JSON.parse(raw) as Partial<BackendRestartIntent>
    captureBackendStepResolved({
      stepStatus: intent.step_status ?? 'downloaded',
      recommendedBackend: intent.recommended_backend ?? null,
      recommendedCategory: intent.recommended_category ?? null,
      currentBackend: intent.current_backend ?? null,
      durationMs: intent.duration_ms ?? null,
      replayed: true,
    })
  } catch {
    // malformed record — nothing worth reporting
  }
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
  /**
   * Which rung of the ladder this machine landed on — see `describeHardware`.
   * Was `'low' | 'standard'`; since ATO-463 it is one of eleven values, which
   * is the point: the old distribution could only ever be two-valued, so no
   * amount of staring at it could show a mis-tiered machine.
   */
  hardwareTier?: string | null
  /** False when the tier deadline elapsed and the fallback was assumed. */
  hardwareTierResolved?: boolean
  /** Which memory pool the tier was decided on: unified / vram / system. */
  memoryKind?: string | null
  /** The budget that decision used, in MiB. Coarse enough not to fingerprint. */
  memoryBudgetMib?: number | null
  /** The single model the screen led with, so impressions have a subject. */
  primaryModelId?: string | null
}): void {
  capture('setup_screen_shown', {
    recommended_count: params.recommendedCount ?? 0,
    rendered: params.rendered,
    hardware_tier: params.hardwareTier ?? null,
    hardware_tier_resolved: params.hardwareTierResolved ?? null,
    memory_kind: params.memoryKind ?? null,
    memory_budget_mib: params.memoryBudgetMib ?? null,
    primary_model_id: params.primaryModelId
      ? normalizeModelId(params.primaryModelId)
      : null,
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
