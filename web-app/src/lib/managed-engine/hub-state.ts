/**
 * A managed engine as a Model Hub format (change `add-tensorrt-llm-model-hub`, design D2; spec
 * `tensorrt-llm-desktop`, "TensorRT-LLM — формат Model Hub по состоянию провайдера", and the same
 * rule for every managed engine, change `add-vllm-runtime`): whether the format is offered at all,
 * and what the Hub shows under it. Decided from the core's state for that engine alone — the Hub
 * has no platform check of its own (ADR 2026-10-01): macOS, Windows on ARM and machines without
 * NVIDIA are left out by the extension hiding the provider.
 */

import type {
  EnvironmentSnapshot,
  ManagedBlocker,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

export type ManagedHubStatus =
  /** No snapshot or no plan yet: the Hub claims nothing. */
  | 'unknown'
  /** Something on the machine has to change first; the plan's blockers say what. */
  | 'blocked'
  /** Models and verdicts are shown; downloading waits for the engine (design D7). */
  | 'not-installed'
  | 'ready'

export interface ManagedHubState {
  /** Whether the format filter offers the engine. */
  visible: boolean
  state: ManagedHubStatus
  /** The plan's blockers when `blocked`, otherwise empty. */
  blockers: ManagedBlocker[]
  /**
   * The descriptor whose curated models and architectures the Hub uses: the installation's own
   * (it is bound to it for good), else the one the plan would install (design D3).
   */
  descriptorId: string | null
}

const NO_BLOCKERS: ManagedBlocker[] = []

/** An engine the Hub knows nothing of: not offered, nothing claimed. */
export const UNKNOWN_HUB_STATE: ManagedHubState = {
  visible: false,
  state: 'unknown',
  blockers: NO_BLOCKERS,
  descriptorId: null,
}

/** A card older than Ampere: no setup fixes that, so the format is not offered (design D2). */
export const COMPUTE_CAPABILITY_TOO_LOW = 'compute-capability-too-low'

export function managedHubState(input: {
  /** The engine's provider is in the provider list: its extension did not hide it. */
  providerShown: boolean
  environment: EnvironmentSnapshot | undefined
  installation: RuntimeInstallation | undefined
  plan: RequirementPlan | undefined
}): ManagedHubState {
  const { providerShown, environment, installation, plan } = input
  // Before the plan is in, the provider's word stands: hiding the format meanwhile would also
  // reset a saved filter of the engine on a machine that has it.
  const visible =
    providerShown && !plan?.blockers.some((blocker) => blocker.reason === COMPUTE_CAPABILITY_TOO_LOW)
  const descriptorId = installation?.active_descriptor_id ?? plan?.descriptor_id ?? null
  const base = { visible, descriptorId, blockers: NO_BLOCKERS }
  if (!environment) return { ...base, state: 'unknown' }
  // The installed engine outranks the plan, as on the provider page: a plan for this machine may
  // carry blockers of a re-install (the disk the image would need again) that do not stop it.
  if (installation?.status === 'ready') return { ...base, state: 'ready' }
  if (!plan) return { ...base, state: 'unknown' }
  if (plan.blockers.length > 0) return { ...base, state: 'blocked', blockers: plan.blockers }
  return { ...base, state: 'not-installed' }
}
