import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { descriptorHint, probe, runtimeTarget } from '@/services/managed-environment/client'
import type { EnvironmentSnapshot, RequirementPlan } from '@/services/managed-environment/types'
import {
  selectEnvironment,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * The core's plan for setting a managed engine up on this machine (`probe(descriptorHint(env))` with
 * the engine's target), shared by every screen that reads it — the provider page's setup and the
 * Model Hub's format of that engine (change `add-tensorrt-llm-model-hub`, design D2) — so the two
 * never disagree. Each engine has its own plan: its blockers (driver, compute capability, disk) are
 * its descriptor's (change `add-vllm-runtime`, design D12), and one engine's plan never answers for
 * another.
 *
 * One probe per engine and state of what the plan depends on (`managedPlanKey`): a new core, another
 * descriptor to install, the WSL distribution appearing or going, the engine installed or removed
 * — and `recheck()`. Not per revision of the snapshot: the core publishes a new revision after every
 * probe (each look at the host), so that would ask forever. Probing changes nothing on the machine.
 * Module state, not component state: a screen opened later reads the plan already held instead of
 * asking again — except the provider page, which asks on every opening (`enabled: false` and its
 * own `recheck()`), as before. A failed probe holds no key.
 */

interface PlanState {
  /** The `managedPlanKey` the held plan answers. */
  key: string | null
  plan: RequirementPlan | undefined
  error: string | null
  probing: boolean
}

const EMPTY: PlanState = { key: null, plan: undefined, error: null, probing: false }

const usePlanStore = create<{ plans: Record<string, PlanState> }>()(() => ({ plans: {} }))

const planOf = (engineId: string): PlanState => usePlanStore.getState().plans[engineId] ?? EMPTY

function setPlan(engineId: string, patch: Partial<PlanState>): void {
  usePlanStore.setState(({ plans }) => ({
    plans: { ...plans, [engineId]: { ...(plans[engineId] ?? EMPTY), ...patch } },
  }))
}

/** The request in flight per engine; a newer one supersedes it, and its late answer is dropped. */
const inflight = new Map<
  string,
  { key: string; sequence: number; promise: Promise<RequirementPlan | undefined> }
>()
let sequence = 0

export function resetManagedPlansForTests(): void {
  inflight.clear()
  sequence = 0
  usePlanStore.setState({ plans: {} })
}

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

/** What the plan of `engineId` depends on; `none` before any snapshot. */
export function managedPlanKey(
  environment: EnvironmentSnapshot | undefined,
  engineId: string
): string {
  if (!environment) return 'none'
  const installation = environment.installations.find((entry) => entry.engine_id === engineId)
  return [
    environment.instance_id,
    descriptorHint(environment, engineId),
    environment.distribution?.name ?? '',
    installation?.status ?? 'absent',
  ].join('|')
}

function request(engineId: string, key: string, environment: EnvironmentSnapshot | undefined) {
  const mine = ++sequence
  setPlan(engineId, { key, probing: true, error: null })
  const promise = probe(descriptorHint(environment, engineId), runtimeTarget(engineId)).then(
    (plan) => {
      if (inflight.get(engineId)?.sequence !== mine) return plan
      inflight.delete(engineId)
      setPlan(engineId, { plan, probing: false, error: null })
      return plan
    },
    (error) => {
      if (inflight.get(engineId)?.sequence !== mine) return undefined
      inflight.delete(engineId)
      // A failure answers nothing about this revision: the next screen asks again.
      setPlan(engineId, { key: null, probing: false, error: errorText(error) })
      return undefined
    }
  )
  inflight.set(engineId, { key, sequence: mine, promise })
  return promise
}

export interface ManagedPlan {
  /** Undefined until the first answer; the last answer stays while a newer one is asked. */
  plan: RequirementPlan | undefined
  probing: boolean
  /** Why the last probe failed, or null. */
  error: string | null
  /** Ask the core again now; resolves to the new plan, undefined when the probe failed. */
  recheck: () => Promise<RequirementPlan | undefined>
}

/**
 * The plan of `engineId`. `enabled: false` asks nothing (for a screen where the provider is hidden)
 * and reads what is held.
 */
export function useManagedPlan(
  engineId: string,
  { enabled = true }: { enabled?: boolean } = {}
): ManagedPlan {
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const key = managedPlanKey(environment, engineId)
  const plan = usePlanStore((state) => state.plans[engineId]?.plan)
  const probing = usePlanStore((state) => state.plans[engineId]?.probing ?? false)
  const error = usePlanStore((state) => state.plans[engineId]?.error ?? null)

  useEffect(() => {
    if (!enabled) return
    if (planOf(engineId).key === key || inflight.get(engineId)?.key === key) return
    void request(engineId, key, selectEnvironment(useManagedEnvironmentStore.getState()))
  }, [enabled, engineId, key])

  const recheck = useCallback(() => {
    const current = selectEnvironment(useManagedEnvironmentStore.getState())
    return request(engineId, managedPlanKey(current, engineId), current)
  }, [engineId])

  return { plan, probing, error, recheck }
}
