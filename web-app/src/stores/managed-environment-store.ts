import { create } from 'zustand'

import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
  ManagedPhase,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

/**
 * The app's copy of the core's managed-runtime state: the container environment on Linux (on
 * Windows, Atomic Chat's own WSL distribution), the managed engines' installations in it and the
 * durable operations that set them up and remove them.
 *
 * The core is the truth and outlives every dialog: a setup keeps running when the window closes,
 * and an operation waiting for the user to sign in again is continued by the next core. So this is
 * rebuilt, never guessed: from the core's snapshot whenever the app attaches to a core (startup,
 * a relay reattach), then from `environment:changed` / `environment:operation` events, each of
 * which carries the whole record with `instance_id` and `revision`. An event is applied only when
 * it comes from the core the last snapshot came from and is strictly newer than what is held —
 * an equal revision is a no-op, an older one would rewind a progress bar. A snapshot from another
 * core replaces everything: a new core starts its revisions again.
 */

/** The parts of the core's control snapshot this store reads. */
export interface ManagedSnapshotPart {
  instance_id: string
  environments?: EnvironmentSnapshot[]
  environment_operations?: EnvironmentOperation[]
}

interface ManagedEnvironmentState {
  /** The core the held records came from; `null` before the first snapshot. */
  instanceId: string | null
  /** False between a detach and the next snapshot: events then describe nothing held here. */
  attached: boolean
  environments: Record<string, EnvironmentSnapshot>
  operations: Record<string, EnvironmentOperation>
  applySnapshot: (snapshot: ManagedSnapshotPart) => void
  applyEnvironment: (environment: EnvironmentSnapshot) => void
  applyOperation: (operation: EnvironmentOperation) => void
  detach: () => void
  reset: () => void
}

const EMPTY = {
  instanceId: null,
  attached: false,
  environments: {},
  operations: {},
}

/** Whether a record may replace the one held: same core as the snapshot, strictly newer. */
function isNewer(
  state: ManagedEnvironmentState,
  incoming: { instance_id: string; revision: number },
  held: { revision: number } | undefined
): boolean {
  if (!state.attached || incoming.instance_id !== state.instanceId) return false
  return held === undefined || incoming.revision > held.revision
}

export const useManagedEnvironmentStore = create<ManagedEnvironmentState>()(
  (set) => ({
    ...EMPTY,
    applySnapshot: (snapshot) =>
      set({
        instanceId: snapshot.instance_id,
        attached: true,
        environments: Object.fromEntries(
          (snapshot.environments ?? []).map((e) => [e.environment_id, e])
        ),
        operations: Object.fromEntries(
          (snapshot.environment_operations ?? []).map((o) => [o.operation_id, o])
        ),
      }),
    applyEnvironment: (environment) =>
      set((state) =>
        isNewer(state, environment, state.environments[environment.environment_id])
          ? {
              environments: {
                ...state.environments,
                [environment.environment_id]: environment,
              },
            }
          : state
      ),
    applyOperation: (operation) =>
      set((state) =>
        isNewer(state, operation, state.operations[operation.operation_id])
          ? {
              operations: {
                ...state.operations,
                [operation.operation_id]: operation,
              },
            }
          : state
      ),
    detach: () => set({ attached: false }),
    reset: () => set({ ...EMPTY }),
  })
)

/** Phases after which an operation does nothing more on its own. */
const FINISHED: ReadonlySet<ManagedPhase> = new Set([
  'ready',
  'removed',
  'cancelled',
  'failed',
])

type Held = Pick<ManagedEnvironmentState, 'environments' | 'operations'>

/** The one environment of this machine user (the core has only ever one). */
export function selectEnvironment(state: Held): EnvironmentSnapshot | undefined {
  return Object.values(state.environments)[0]
}

/** The installation of the managed engine `engineId`, if the core holds one. */
export function selectInstallation(
  state: Held,
  engineId: string
): RuntimeInstallation | undefined {
  return selectEnvironment(state)?.installations.find(
    (installation) => installation.engine_id === engineId
  )
}

const isEngineOperation = (operation: EnvironmentOperation, engineId: string) =>
  operation.target.kind === 'runtime' && operation.target.engine_id === engineId

const isEnvironmentRemoval = (operation: EnvironmentOperation) =>
  operation.target.kind === 'environment' && operation.kind === 'remove'

/** The environment's operations still in progress: the active one when the core names it. */
function unfinished(state: Held): EnvironmentOperation[] {
  const active = selectEnvironment(state)?.active_operation_id
  const candidates = active ? [state.operations[active]] : Object.values(state.operations)
  return candidates.filter(
    (operation): operation is EnvironmentOperation =>
      operation !== undefined && !FINISHED.has(operation.phase)
  )
}

/**
 * The setup or removal of `engineId` still in progress — what the engine's provider page shows after
 * the window was closed and opened again — or `undefined` when none is. On Windows that includes the
 * removal of the environment itself, Atomic Chat's WSL distribution (change
 * `add-tensorrt-llm-windows`), which every managed engine's page can start. Without `engineId`, the
 * operation of any engine: the one notification card follows whichever is running.
 */
export function selectSetupOperation(
  state: Held,
  engineId?: string
): EnvironmentOperation | undefined {
  return unfinished(state).find(
    (operation) =>
      isEnvironmentRemoval(operation) ||
      (engineId === undefined
        ? operation.target.kind === 'runtime'
        : isEngineOperation(operation, engineId))
  )
}

/**
 * Another managed engine's setup or removal still in progress, while `engineId` has none: the core
 * runs one environment operation at a time, so this engine's install waits for it (spec
 * `vllm-desktop`, "Установка vLLM тем же сценарием окружения").
 */
export function selectOtherEngineOperation(
  state: Held,
  engineId: string
): EnvironmentOperation | undefined {
  return unfinished(state).find(
    (operation) => operation.target.kind === 'runtime' && operation.target.engine_id !== engineId
  )
}

/**
 * The last setup of `engineId` that ended in `failed`, kept visible with its error until the engine
 * is installed or a new attempt starts. Operations carry no time, so "last" is the snapshot's and
 * the events' own order. Without `engineId`, the last failed setup of any engine.
 */
export function selectFailedSetup(
  state: Held,
  engineId?: string
): EnvironmentOperation | undefined {
  return Object.values(state.operations)
    .filter(
      (operation) =>
        operation.kind === 'setup' &&
        operation.phase === 'failed' &&
        operation.target.kind === 'runtime' &&
        (engineId === undefined || operation.target.engine_id === engineId)
    )
    .at(-1)
}

/**
 * The last removal of the environment itself (Windows: Atomic Chat's WSL distribution) that ended
 * in `failed`, so the provider page can say why the distribution is still there.
 */
export function selectFailedEnvironmentRemoval(state: Held): EnvironmentOperation | undefined {
  return Object.values(state.operations)
    .filter(
      (operation) =>
        operation.kind === 'remove' &&
        operation.phase === 'failed' &&
        operation.target.kind === 'environment'
    )
    .at(-1)
}
