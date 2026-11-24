import { invoke } from '@tauri-apps/api/core'

import { contextSupport } from '@/lib/context-support'
import type { ContextPlan, ContextPlanBasis } from '@/lib/core-context-contract'

/**
 * The core's context plan for a local model — the window a load gets on this device by default and
 * the largest one it holds — read from `GET /models/:provider/*modelId/capabilities` through the
 * Rust relay (`atomic_core_call`). An older core answers without `contextPlan`, and then there is no
 * plan: the context controls show what they showed before.
 *
 * The plan follows the memory that is free, so an answer is kept for a minute only; concurrent asks
 * for one model share a call.
 */

const PLAN_TTL_MS = 60_000

const BASES: ReadonlySet<string> = new Set([
  'unified',
  'gpu',
  'cpu',
  'engine',
  'model',
])

const cache = new Map<
  string,
  { at: number; plan: Promise<ContextPlan | undefined> }
>()

/** For tests. */
export function resetContextPlanCache(): void {
  cache.clear()
}

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined

/** The `contextPlan` of a capabilities answer, or `undefined` when it has none that holds up. */
export function readContextPlan(
  capabilities: unknown
): ContextPlan | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined
  const raw = (capabilities as { contextPlan?: unknown }).contextPlan
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const maxCtx = positive(record.maxCtx)
  const recommendedCtx = positive(record.recommendedCtx)
  if (maxCtx === undefined || recommendedCtx === undefined) return undefined
  if (typeof record.basis !== 'string' || !BASES.has(record.basis)) {
    return undefined
  }
  const trainedCtx = positive(record.trainedCtx)
  const kvBytesPerToken = positive(record.kvBytesPerToken)
  return {
    recommendedCtx,
    maxCtx,
    ...(trainedCtx !== undefined ? { trainedCtx } : {}),
    ...(kvBytesPerToken !== undefined ? { kvBytesPerToken } : {}),
    basis: record.basis as ContextPlanBasis,
  }
}

/**
 * `providerId`'s plan for `modelId`; `undefined` for a provider that is not a local engine, an
 * older core, or any failure.
 */
export function fetchContextPlan(
  providerId: string,
  modelId: string
): Promise<ContextPlan | undefined> {
  if (contextSupport(providerId).resize === undefined) {
    return Promise.resolve(undefined)
  }
  const key = `${providerId}::${modelId}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && now - cached.at < PLAN_TTL_MS) return cached.plan
  const plan = invoke<unknown>('atomic_core_call', {
    method: 'GET',
    // Ids contain `/`; the core matches on the rest of the path, unencoded.
    path: `/models/${providerId}/${modelId}/capabilities`,
    body: null,
  })
    .then(readContextPlan)
    .catch((error) => {
      console.debug(
        `[context] plan unavailable for ${providerId}/${modelId}:`,
        error
      )
      return undefined
    })
  cache.set(key, { at: now, plan })
  return plan
}

/**
 * What the context controls say about the device: the largest window it holds for the model and,
 * when that is below what the model was trained for (the plan's own figure, else `trainedMax` from
 * the engine), that training maximum too, so a slider reaching further does not read as reachable.
 */
export function deviceContextLimit(
  plan: ContextPlan | undefined,
  trainedMax?: number
): { maxCtx: number; trainedCtx?: number } | undefined {
  if (!plan) return undefined
  const trained = plan.trainedCtx ?? positive(trainedMax)
  return trained !== undefined && plan.maxCtx < trained
    ? { maxCtx: plan.maxCtx, trainedCtx: trained }
    : { maxCtx: plan.maxCtx }
}
