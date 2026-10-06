import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { descriptorHint, probe } from '@/services/managed-environment/client'
import type { EnvironmentSnapshot, RequirementPlan } from '@/services/managed-environment/types'
import {
  selectEnvironment,
  TENSORRT_LLM_ENGINE_ID,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * The core's plan for setting TensorRT-LLM up on this machine (`probe(descriptorHint(env))`), shared
 * by every screen that reads it — the provider page's setup and the Model Hub's TensorRT-LLM format
 * (change `add-tensorrt-llm-model-hub`, design D2) — so the two never disagree.
 *
 * One probe per state of what the plan depends on (`tensorrtPlanKey`): a new core, another
 * descriptor to install, the WSL distribution appearing or going, the engine installed or removed
 * — and `recheck()`. Not per revision of the snapshot: the core publishes a new revision after every
 * probe (each look at the host), so that would ask forever. Probing changes nothing on the machine.
 * Module state, not component state: a screen opened later reads the plan already held instead of
 * asking again — except the provider page, which asks on every opening (`enabled: false` and its
 * own `recheck()`), as before. A failed probe holds no key.
 */

interface PlanState {
  /** The `tensorrtPlanKey` the held plan answers. */
  key: string | null
  plan: RequirementPlan | undefined
  error: string | null
  probing: boolean
}

const EMPTY: PlanState = { key: null, plan: undefined, error: null, probing: false }

const usePlanStore = create<PlanState>()(() => EMPTY)

/** The request in flight; a newer one supersedes it, and its late answer is dropped. */
let inflight: { key: string; sequence: number; promise: Promise<RequirementPlan | undefined> } | null =
  null
let sequence = 0

export function resetTensorrtPlanForTests(): void {
  inflight = null
  sequence = 0
  usePlanStore.setState(EMPTY)
}

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

/** What the plan depends on; `none` before any snapshot. */
export function tensorrtPlanKey(environment: EnvironmentSnapshot | undefined): string {
  if (!environment) return 'none'
  const installation = environment.installations.find(
    (entry) => entry.engine_id === TENSORRT_LLM_ENGINE_ID
  )
  return [
    environment.instance_id,
    descriptorHint(environment),
    environment.distribution?.name ?? '',
    installation?.status ?? 'absent',
  ].join('|')
}

function request(key: string, environment: EnvironmentSnapshot | undefined) {
  const mine = ++sequence
  usePlanStore.setState({ key, probing: true, error: null })
  const promise = probe(descriptorHint(environment)).then(
    (plan) => {
      if (inflight?.sequence !== mine) return plan
      inflight = null
      usePlanStore.setState({ plan, probing: false, error: null })
      return plan
    },
    (error) => {
      if (inflight?.sequence !== mine) return undefined
      inflight = null
      // A failure answers nothing about this revision: the next screen asks again.
      usePlanStore.setState({ key: null, probing: false, error: errorText(error) })
      return undefined
    }
  )
  inflight = { key, sequence: mine, promise }
  return promise
}

export interface TensorrtPlan {
  /** Undefined until the first answer; the last answer stays while a newer one is asked. */
  plan: RequirementPlan | undefined
  probing: boolean
  /** Why the last probe failed, or null. */
  error: string | null
  /** Ask the core again now; resolves to the new plan, undefined when the probe failed. */
  recheck: () => Promise<RequirementPlan | undefined>
}

/** `enabled: false` asks nothing (for a screen where the provider is hidden) and reads what is held. */
export function useTensorrtPlan({ enabled = true }: { enabled?: boolean } = {}): TensorrtPlan {
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const key = tensorrtPlanKey(environment)
  const plan = usePlanStore((state) => state.plan)
  const probing = usePlanStore((state) => state.probing)
  const error = usePlanStore((state) => state.error)

  useEffect(() => {
    if (!enabled) return
    if (usePlanStore.getState().key === key || inflight?.key === key) return
    void request(key, selectEnvironment(useManagedEnvironmentStore.getState()))
  }, [enabled, key])

  const recheck = useCallback(() => {
    const current = selectEnvironment(useManagedEnvironmentStore.getState())
    return request(tensorrtPlanKey(current), current)
  }, [])

  return { plan, probing, error, recheck }
}
