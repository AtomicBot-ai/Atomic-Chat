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
import { queuedCapture } from '@/lib/telemetry-queue'

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
  const { experiment, variant, assignedAt } = raw as Record<string, unknown>
  if (experiment !== ONBOARDING_EXPERIMENT || !isOnboardingVariant(variant))
    return null
  return {
    experiment,
    variant,
    assignedAt: typeof assignedAt === 'number' ? assignedAt : 0,
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
  queuedCapture('onboarding_cohort_assigned', cohortProperties(cohort))
  return cohort
}

function cohortProperties(cohort: OnboardingCohort) {
  return {
    onboarding_experiment: cohort.experiment,
    onboarding_variant: cohort.variant,
  }
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
  client.register(properties)
  client.setPersonProperties(undefined, {
    ...properties,
    onboarding_assigned_at: new Date(cohort.assignedAt).toISOString(),
  })
}
