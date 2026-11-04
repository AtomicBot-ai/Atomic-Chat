/**
 * The chat model the Local API Server serves, and loading it where Start is
 * not the one asking: "Start automatically" at launch (B01, QA 2.3.2) and
 * Connect on a server that runs without it. Both load it the way Start does
 * (`useLocalApiServerControl`): `ensureModelForServer` under the load
 * watchdog, then the record of what the server serves and the active models.
 * ADR 2026-11-03-start-the-local-api-server-at-launch-with-its-last-model.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isAnswerableModel } from '@/lib/answerable-model'
import { MODEL_LOAD_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'
import { readLoadedContextLength } from '@/utils/apiServerCapacity'
import {
  ensureModelForServer,
  resolveServerModels,
  type EnsureModelDeps,
  type EnsureModelResult,
} from '@/utils/ensureModelForServer'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

export type ServedModel = { model: string; provider: string }

type ServedModelSource = {
  lastServerModels: ServedModel[]
  defaultModelLocalApiServer: ServedModel | null
}

/** The model the server serves now, else the one it will start with. */
export function servedModel(
  server: ServedModelSource = useLocalApiServer.getState()
): ServedModel | null {
  const last = server.lastServerModels[0]
  if (last?.model) return last
  const fallback = server.defaultModelLocalApiServer
  return fallback?.model ? fallback : null
}

/** The id of {@link servedModel}: what agents are told to ask for. */
export function servedModelId(
  server: ServedModelSource = useLocalApiServer.getState()
): string | null {
  return servedModel(server)?.model ?? null
}

/**
 * The window `served` (by default the model the server serves) was loaded
 * with, when its engine says; `undefined` otherwise. Agents are told it so
 * they compact before the server refuses. Never throws.
 */
export async function servedContextLength(
  served?: ServedModel | null
): Promise<number | undefined> {
  try {
    const target = served === undefined ? servedModel() : served
    if (!target) return undefined
    return await readLoadedContextLength(target.provider, target.model)
  } catch {
    return undefined
  }
}

/**
 * Whether there is something to load for `wanted`: a model a local engine
 * still lists, on a provider that is switched on, that can chat. A cloud
 * model has nothing to load, and a deleted one must not make
 * `ensureModelForServer` pick some other model in its place.
 */
export function canLoadForServer(wanted: ServedModel): boolean {
  if (!isLocalProvider(wanted.provider)) return false
  const provider = useModelProvider
    .getState()
    .getProviderByName(wanted.provider)
  if (!provider || provider.active === false) return false
  const model = provider.models?.find((m) => m.id === wanted.model)
  return Boolean(model && isAnswerableModel(model))
}

/**
 * Load `wanted` for the server and record what it serves: `lastServerModels`,
 * named by the provider whose engine holds each session, and the active
 * models. Throws what the load throws, the watchdog's timeout included.
 */
export async function loadServedModel(
  modelsService: EnsureModelDeps['modelsService'],
  wanted: ServedModel
): Promise<EnsureModelResult> {
  // ATO-270: the model load has no timeout of its own.
  const result = await withTimeout(
    ensureModelForServer({ modelsService, modelOverride: wanted }),
    MODEL_LOAD_WATCHDOG_MS,
    'Timed out waiting for the model to finish loading.'
  )
  if (result.status === 'no_model_available') return result

  const activeModels =
    (await modelsService.getActiveModels().catch(() => [] as string[])) ?? []
  if (activeModels.length > 0) {
    const serverModels = await resolveServerModels(
      activeModels,
      modelsService,
      wanted.provider
    )
    if (serverModels.length > 0) {
      useLocalApiServer.getState().setLastServerModels(serverModels)
    }
  }
  syncActiveModelsFromEngines(activeModels)
  return result
}

/**
 * Make sure the running server holds the model it serves before an agent is
 * pointed at it. The server can be up with nothing loaded (a launch whose
 * load failed or was skipped, a model that crashed), and an agent sent there
 * asking for that model gets 503 on every request. Nothing to load (no
 * served model, a cloud one, one since deleted) or a model already running
 * resolves at once. Throws when the load fails.
 */
export async function ensureServedModelRunning(
  modelsService: EnsureModelDeps['modelsService'] = getServiceHub().models()
): Promise<void> {
  const wanted = servedModel()
  if (!wanted || !canLoadForServer(wanted)) return
  const running =
    (await modelsService.getActiveModels().catch(() => [] as string[])) ?? []
  if (running.includes(wanted.model)) return
  const result = await loadServedModel(modelsService, wanted)
  if (result.status === 'no_model_available') {
    throw new Error('No model available to load')
  }
}
