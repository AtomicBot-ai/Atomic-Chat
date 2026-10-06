/**
 * The core's managed-runtime control routes (openspec change `add-tensorrt-llm-linux`), called
 * through the Rust relay like every other core call: the webview never holds the control token.
 * One function per route, bodies exactly as the core validates them — the core refuses unknown
 * fields, because the same surface ends in a privileged step.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  EnvironmentOperation,
  EnvironmentResetResult,
  EnvironmentSnapshot,
  ManagedOperationKind,
  ManagedOperationTarget,
  RequirementPlan,
  Sha256Digest,
} from './types'
import type { ManagedSnapshotPart } from '@/stores/managed-environment-store'

/** The installation the app sets up; the core's own convention, one per user. */
export const TENSORRT_LLM_TARGET: ManagedOperationTarget = {
  kind: 'runtime',
  installation_id: 'tensorrt-llm',
  engine_id: 'tensorrt-llm',
}

function coreCall<T>(method: 'GET' | 'POST', path: string, body: unknown = null): Promise<T> {
  return invoke<T>('atomic_core_call', { method, path, body })
}

/** The environment parts of the core's snapshot, as the relay last read it. */
export async function readManagedSnapshot(): Promise<ManagedSnapshotPart> {
  const { snapshot } = await invoke<{ snapshot: ManagedSnapshotPart }>('atomic_core_snapshot')
  return snapshot
}

export async function listEnvironments(): Promise<EnvironmentSnapshot[]> {
  const { environments } = await coreCall<{ environments: EnvironmentSnapshot[] }>(
    'GET',
    '/environments'
  )
  return environments ?? []
}

/**
 * What setting the engine up would involve, computed without touching the machine. The
 * `descriptor_id` is a preference: an uncached one gets the newest descriptor, named in the plan
 * (ruling R-app-4).
 */
export function probe(
  descriptorId: string,
  target: ManagedOperationTarget = TENSORRT_LLM_TARGET
): Promise<RequirementPlan> {
  return coreCall('POST', '/environments/probe', { descriptor_id: descriptorId, target })
}

export function beginOperation(
  environmentId: string,
  request: {
    request_id: string
    kind: ManagedOperationKind
    target?: ManagedOperationTarget
    descriptor_id?: string
    retain_models?: boolean
    approved_plan_digest?: Sha256Digest
  }
): Promise<EnvironmentOperation> {
  const { target = TENSORRT_LLM_TARGET, ...rest } = request
  return coreCall('POST', `/environments/${encodeURIComponent(environmentId)}/operations`, {
    ...rest,
    target,
  })
}

export function getOperation(operationId: string): Promise<EnvironmentOperation> {
  return coreCall('GET', `/environments/operations/${encodeURIComponent(operationId)}`)
}

export function cancelOperation(operationId: string): Promise<EnvironmentOperation> {
  return coreCall('POST', `/environments/operations/${encodeURIComponent(operationId)}/cancel`)
}

export function resumeOperation(
  operationId: string,
  expectedRevision: number,
  approvedPlanDigest?: Sha256Digest
): Promise<EnvironmentOperation> {
  return coreCall('POST', `/environments/operations/${encodeURIComponent(operationId)}/resume`, {
    expected_revision: expectedRevision,
    ...(approvedPlanDigest ? { approved_plan_digest: approvedPlanDigest } : {}),
  })
}

/** The engine id, sent as the probe's descriptor preference before anything is installed. */
const TENSORRT_LLM_ENGINE_ID = 'tensorrt-llm'

/**
 * The `descriptor_id` a TensorRT-LLM probe names: the installed engine's own, otherwise the engine
 * id, which the core resolves to its newest descriptor and names in the plan (ruling R-app-4).
 */
export function descriptorHint(environment: EnvironmentSnapshot | undefined): string {
  const installed = environment?.installations.find(
    (installation) =>
      installation.engine_id === TENSORRT_LLM_ENGINE_ID && installation.active_descriptor_id
  )
  return installed?.active_descriptor_id ?? TENSORRT_LLM_ENGINE_ID
}

export type HostStepAnswer =
  | { outcome: 'completed' | 'reboot-required' | 'failed' | 'declined'; log_tail?: string }
  | { outcome: 'manual'; command: string }

/**
 * Run the privileged step the operation waits on (Rust: `pkexec` on a copy of the core on Linux,
 * the UAC prompt on Windows). Only the operation id crosses over: Rust reads the step from the
 * core and writes the request itself. `manual` hands over a command to run by hand: on Linux the
 * receipt follows once it ran, on Windows (UAC cannot be raised) the person checks again.
 */
export function runHostStep(operationId: string): Promise<HostStepAnswer> {
  return invoke<HostStepAnswer>('atomic_core_run_host_step', { operationId })
}

/**
 * Archive the environment's finished operations (core 0.9.6+), so no failed setup is shown or
 * resumed and the next setup starts from a fresh plan. Installs and removes nothing; the core
 * refuses while an operation is still running.
 */
export function resetEnvironment(environmentId: string): Promise<EnvironmentResetResult> {
  return coreCall('POST', `/environments/${encodeURIComponent(environmentId)}/reset`)
}

/**
 * The core's read-only report on the environment (core 0.9.6+): the snapshot, where each conf
 * document comes from and what is cached, every operation on disk, recent warnings. Kept as plain
 * JSON: it only ever travels to the clipboard.
 */
export function environmentDiagnostics(environmentId: string): Promise<Record<string, unknown>> {
  return coreCall('GET', `/environments/${encodeURIComponent(environmentId)}/diagnostics`)
}
