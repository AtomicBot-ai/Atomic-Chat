/**
 * The onboarding experiment: every new install is put in one of the three
 * first-run variants (`none`, `model_only`, `full`) at random, once, and keeps
 * it. PostHog gets the cohort on the person and on every event, so the funnel
 * to a first `chat_request_sent` and retention can be compared per cohort.
 *
 * The cohort is drawn on the device, before React mounts, rather than read
 * from a PostHog feature flag: the first screen depends on it, and a flag
 * would have to come over the network before that screen, on a first launch
 * that may be offline. Installs that used the app before the experiment are
 * left out, and so is a dev build that pins a variant
 * (`FORCE_ONBOARDING_VARIANT`).
 */

import type { PostHog } from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'

import {
  forcedOnboardingVariant,
  isOnboardingVariant,
  ONBOARDING_VARIANTS,
  type OnboardingVariant,
} from './steps'

/** The experiment running now. A later one takes a new name, so its cohorts start clean. */
export const ONBOARDING_EXPERIMENT = 'onboarding_v1'

export type OnboardingCohort = {
  experiment: string
  variant: OnboardingVariant
  /** When the install was put in it, ms since the epoch. */
  assignedAt: number
  /** The SDK accepted the assignment event; not a server delivery receipt. */
  assignmentCaptured?: boolean
}

/** This install's cohort in the running experiment, or `null` (not in it). */
export function readOnboardingCohort(): OnboardingCohort | null {
  if (typeof window === 'undefined') return null
  let raw: unknown
  try {
    raw = JSON.parse(
      localStorage.getItem(localStorageKey.onboardingCohort) ?? 'null'
    )
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { experiment, variant, assignedAt, assignmentCaptured } = raw as Record<
    string,
    unknown
  >
  if (experiment !== ONBOARDING_EXPERIMENT || !isOnboardingVariant(variant))
    return null
  return {
    experiment,
    variant,
    assignedAt: typeof assignedAt === 'number' ? assignedAt : 0,
    ...(assignmentCaptured === true ? { assignmentCaptured: true } : {}),
  }
}

/** One of the variants with equal odds; `random` is in [0, 1). */
export function drawOnboardingVariant(
  random: () => number = Math.random
): OnboardingVariant {
  const index = Math.min(
    Math.floor(random() * ONBOARDING_VARIANTS.length),
    ONBOARDING_VARIANTS.length - 1
  )
  return ONBOARDING_VARIANTS[index]
}

/**
 * Puts a new install in a cohort on its first launch and returns the cohort
 * it is in, if any. Call once, before React mounts, after
 * `rememberFirstLaunch` (`firstLaunch` is `isFirstLaunch()`). An install
 * already in the experiment keeps its cohort; one that is not on its first
 * launch, or whose variant a dev build pins, stays out.
 */
export function assignOnboardingCohort({
  firstLaunch,
  random = Math.random,
  now = Date.now,
}: {
  firstLaunch: boolean
  random?: () => number
  now?: () => number
}): OnboardingCohort | null {
  const existing = readOnboardingCohort()
  if (existing) return existing
  if (!firstLaunch || forcedOnboardingVariant() !== null) return null

  const cohort: OnboardingCohort = {
    experiment: ONBOARDING_EXPERIMENT,
    variant: drawOnboardingVariant(random),
    assignedAt: now(),
  }
  try {
    localStorage.setItem(
      localStorageKey.onboardingCohort,
      JSON.stringify(cohort)
    )
  } catch {
    // Storage refused: the install stays out of the experiment (and gets the
    // full flow), since the next launch could not tell which cohort it was in.
    return null
  }
  return cohort
}

function cohortProperties(cohort: OnboardingCohort) {
  return {
    onboarding_experiment: cohort.experiment,
    onboarding_variant: cohort.variant,
  }
}

function assignmentTimestamp(cohort: OnboardingCohort): Date | null {
  const timestamp = new Date(cohort.assignedAt)
  return cohort.assignedAt > 0 && Number.isFinite(timestamp.getTime())
    ? timestamp
    : null
}

/**
 * Tells PostHog which cohort this install is in: on the person, set once so a
 * later launch can never move it, and as super-properties so every event
 * (`app_opened`, `chat_request_sent`, `api_server_request`, …) carries it.
 * Call after `posthog.init` and the identity restore, before the queued
 * events are flushed. An install outside the experiment is left untouched.
 */
export function registerOnboardingCohort(
  client: Pick<PostHog, 'register' | 'setPersonProperties'>
): void {
  const cohort = readOnboardingCohort()
  if (!cohort) return
  const properties = cohortProperties(cohort)
  const timestamp = assignmentTimestamp(cohort)
  client.register(properties)
  client.setPersonProperties(undefined, {
    ...properties,
    ...(timestamp ? { onboarding_assigned_at: timestamp.toISOString() } : {}),
  })
}

/**
 * Report the persisted assignment only after analytics is ready. Old builds
 * lost this event before init; their stored timestamp lets a later launch
 * recover the original entry time. A declined/failed capture stays pending.
 */
export function captureOnboardingCohort(
  client: Pick<PostHog, 'capture'>
): void {
  const cohort = readOnboardingCohort()
  if (!cohort || cohort.assignmentCaptured) return
  const timestamp = assignmentTimestamp(cohort)
  if (!timestamp) return

  try {
    const captured = client.capture(
      'onboarding_cohort_assigned',
      cohortProperties(cohort),
      { timestamp, send_instantly: true }
    )
    if (!captured) return
    localStorage.setItem(
      localStorageKey.onboardingCohort,
      JSON.stringify({ ...cohort, assignmentCaptured: true })
    )
  } catch (error) {
    console.debug('Onboarding assignment capture failed:', error)
  }
}
