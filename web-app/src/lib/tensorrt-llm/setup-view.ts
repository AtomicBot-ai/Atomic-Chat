/**
 * What the TensorRT-LLM provider page shows, decided from the core's state alone: its last plan
 * for this machine, the setup or removal in progress, the installation, and the last setup that
 * failed. Pure, so each spec scenario (`tensorrt-llm-desktop`) is pinned by a test rather than by
 * a component.
 */

import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
  ManagedBlocker,
  ManagedPlanWarning,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

/** Where an operation in progress stands, as far as the person is concerned. */
export type OperationStep =
  /** The core asks for consent again (the machine changed under the plan). */
  | 'consent'
  /** The one privileged step waits for the OS authorization prompt (`pkexec`, or UAC on Windows). */
  | 'host-step'
  /** Docker group membership takes effect at the next sign-in. */
  | 'relogin'
  /** WSL was just turned on; Windows finishes it at the next restart. */
  | 'reboot'
  /** Checking, pulling, verifying, activating, removing, cancelling: work the core does alone. */
  | 'working'

export type SetupView =
  | { kind: 'checking' }
  | { kind: 'blocked'; blockers: BlockerView[] }
  | { kind: 'not-installed'; plan: RequirementPlan }
  | { kind: 'operation'; operation: EnvironmentOperation; step: OperationStep }
  | {
      kind: 'failed'
      operation: EnvironmentOperation
      /**
       * What the machine can be set up with now, when that is not what the failed setup was approved
       * for — typically a newer descriptor published after it failed. "Try again" resumes the failed
       * setup with the plan it was approved for, never this one.
       */
      newerPlan?: RequirementPlan
    }
  | { kind: 'installed'; installation: RuntimeInstallation }

export interface SetupState {
  plan?: RequirementPlan
  /** The operation still running, if any (`selectSetupOperation`). */
  operation?: EnvironmentOperation
  installation?: RuntimeInstallation
  /** The last TensorRT-LLM operation that ended in `failed`. */
  failed?: EnvironmentOperation
}

/**
 * A running operation outranks everything: it is what the person is waiting on, and the plan may
 * already be stale because of it (the pull uses the disk the plan counted). Then the installed
 * engine, then a failure to retry, then what the last probe said.
 */
export function deriveSetupView(state: SetupState): SetupView {
  const { plan, operation, installation, failed } = state
  if (operation) return { kind: 'operation', operation, step: stepOf(operation) }
  if (installation?.status === 'ready') return { kind: 'installed', installation }
  if (failed) {
    const newerPlan = planNewerThanFailed(plan, failed)
    return newerPlan ? { kind: 'failed', operation: failed, newerPlan } : { kind: 'failed', operation: failed }
  }
  if (!plan) return { kind: 'checking' }
  if (plan.availability === 'unsupported' || plan.availability === 'prerequisite-blocked') {
    return { kind: 'blocked', blockers: plan.blockers.map(blockerView) }
  }
  return { kind: 'not-installed', plan }
}

/**
 * The current plan, when it could start and is not the one the failed setup was approved for. A
 * failed setup stays pinned to the descriptor it was consented with (the core resumes it with that
 * one only), so a fix published since — a lower driver floor, say — reaches the person only through
 * a new setup with the new plan. The plan digest covers the descriptor, so a new descriptor always
 * shows here; a setup that failed before any consent has nothing to compare and gets none.
 */
function planNewerThanFailed(
  plan: RequirementPlan | undefined,
  failed: EnvironmentOperation
): RequirementPlan | undefined {
  if (!plan || failed.approved_plan_digest === null) return undefined
  if (plan.availability === 'unsupported' || plan.availability === 'prerequisite-blocked') return undefined
  return plan.plan_digest === failed.approved_plan_digest ? undefined : plan
}

export function stepOf(operation: EnvironmentOperation): OperationStep {
  switch (operation.phase) {
    case 'awaiting-consent':
      return 'consent'
    case 'preparing-host':
      return operation.pending_host_step ? 'host-step' : 'working'
    case 'relogin-required':
      return 'relogin'
    case 'reboot-required':
      return 'reboot'
    default:
      return 'working'
  }
}

export interface BlockerView {
  message: string
  /** Exact shell commands for a manual fix (Arch, a group-only host). */
  commands: string[]
  /** A card older than Ampere: the capability it needs and the one it has. */
  ampere: { required: string; actual: string } | null
}

export function blockerView(blocker: ManagedBlocker): BlockerView {
  return {
    message: blocker.message,
    commands: blocker.commands ?? [],
    ampere:
      blocker.reason === 'compute-capability-too-low' &&
      blocker.params?.required &&
      blocker.params.actual
        ? { required: blocker.params.required, actual: blocker.params.actual }
        : null,
  }
}

export interface PlanSummary {
  /** The core's own words for each system change; warnings are the ones that bite later. */
  changes: Array<{ text: string; warning: boolean }>
  relogin: boolean
  /** Windows may need a restart once WSL is turned on; the setup then goes on by itself. */
  reboot: boolean
  downloadBytes: number | null
  disk: {
    /**
     * What `path` is: Docker's storage on Linux, the folder of Atomic Chat's WSL distribution on
     * Windows (its space is the space on that volume).
     */
    location: 'docker' | 'distribution'
    path: string | null
    requiredBytes: number | null
    freeBytes: number | null
    insufficient: boolean
  }
  notices: string[]
  /** What the person should know before agreeing; none of it withholds consent. */
  warnings: WarningView[]
  blockers: BlockerView[]
  /** Consent is offered only for a plan that can run. */
  canStart: boolean
}

/**
 * Group membership is root-equivalent; a Docker restart stops the person's containers; turning on
 * WSL asks for administrator approval and may need a restart.
 */
const WARNING_CHANGES = new Set(['add-user-to-docker-group', 'restart-docker', 'enable-wsl'])

/**
 * `notices` are the NVIDIA notices of the plan's descriptor, when the core reported them;
 * `executor` is the environment's, which says what the plan's disk path is.
 */
export function planSummary(
  plan: RequirementPlan,
  notices: string[] = [],
  executor: EnvironmentSnapshot['executor'] = 'linux-docker'
): PlanSummary {
  const disk = plan.blockers.find((b) => b.reason === 'insufficient-disk')
  const number = (value: string | undefined) =>
    value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null
  return {
    changes: plan.system_changes.map((change) => ({
      text: change.text,
      warning: WARNING_CHANGES.has(change.code),
    })),
    relogin: plan.may_require_relogin,
    reboot: plan.may_require_reboot,
    downloadBytes: plan.download_bytes,
    disk: {
      location: executor === 'wsl-docker' ? 'distribution' : 'docker',
      path: plan.docker_root_dir ?? null,
      requiredBytes: plan.required_disk_bytes ?? number(disk?.params?.required),
      freeBytes: plan.free_disk_bytes ?? number(disk?.params?.free),
      insufficient: disk !== undefined,
    },
    notices,
    // A core built before task 2.23 sends no `warnings` at all.
    warnings: (plan.warnings ?? []).map(warningView),
    blockers: plan.blockers.map(blockerView),
    canStart:
      plan.blockers.length === 0 &&
      plan.availability !== 'unsupported' &&
      plan.availability !== 'prerequisite-blocked',
  }
}

export interface WarningView {
  /** The core's own words: what it found and what to do. */
  text: string
  /**
   * The routes that cover Docker's address pools, for the app's own explanation of
   * `docker-address-pools-overlap-routes`; null for any other warning, shown by its text alone.
   */
  addressPools: { routes: string | null } | null
}

export function warningView(warning: ManagedPlanWarning): WarningView {
  return {
    text: warning.text,
    addressPools:
      warning.code === 'docker-address-pools-overlap-routes'
        ? { routes: warning.params?.routes || null }
        : null,
  }
}
