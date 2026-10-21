/**
 * Turning the Local API Server off, wherever it is turned off from: the
 * Server sidebar's Stop, the Server pages and the tray.
 *
 * A model is up only while the server is: loading a chat model raises the
 * server (`switchModel.ts`), and so do an image or video, embedding or
 * decision model (`raiseLocalApiServerForMediaModel`). The reverse holds
 * here: the server going off lets every model it serves go. A restart (a new
 * host, key or model) is not a turn-off and keeps them
 * (`restartLocalApiServer`). The next start brings the chat model back
 * (`ensureModelForServer`) and switches the embedding and decision models it
 * switched off back on (`resumeServedHelperModels`).
 */

import {
  useLocalApiServer,
  type ServedHelperKind,
} from '@/hooks/useLocalApiServer'
import { getServiceHub } from '@/hooks/useServiceHub'
import { stopDecisionModel } from '@/lib/decision/models'
import { stopEmbeddingModel } from '@/lib/embedding/models'
import type { ServiceHub } from '@/services'
import type { DecisionService } from '@/services/decision/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'
import {
  hasResidentEmbeddingModel,
  hasResidentMediaModel,
  setLocalApiServerRunning,
} from '@/utils/localApiServerControl'
import { stopAllLocalModelsByUser } from '@/utils/switchModel'

/** Whether a decision model is switched on; anything that cannot tell reads as "no". */
async function hasResidentDecisionModel(
  decision: Pick<DecisionService, 'isSupported' | 'getStatus'>
): Promise<boolean> {
  try {
    if (!decision.isSupported()) return false
    return (await decision.getStatus()).enabled
  } catch {
    return false
  }
}

/**
 * Unload what the server answers with: the local chat models (recorded as a
 * user stop, so the composer does not load one straight back), an image or
 * video model, and switch the embedding and decision models off. Best effort:
 * a model that will not let go is logged and never keeps the server up.
 */
export async function unloadServedModels(
  hub: ServiceHub = getServiceHub()
): Promise<void> {
  const paused: ServedHelperKind[] = []
  const steps: Array<[string, () => Promise<void>]> = [
    [
      'chat',
      async () => {
        await stopAllLocalModelsByUser(hub)
        syncActiveModelsFromEngines([])
      },
    ],
    [
      'media',
      async () => {
        if (await hasResidentMediaModel(hub.diffusion()))
          await useImageGenerationStore.getState().unloadModel()
      },
    ],
    [
      'embedding',
      async () => {
        if (!(await hasResidentEmbeddingModel(hub.embedding()))) return
        await stopEmbeddingModel()
        paused.push('embedding')
      },
    ],
    [
      'decision',
      async () => {
        if (!(await hasResidentDecisionModel(hub.decision()))) return
        await stopDecisionModel()
        paused.push('decision')
      },
    ],
  ]
  const results = await Promise.allSettled(steps.map(([, run]) => run()))
  results.forEach((result, index) => {
    if (result.status === 'rejected')
      console.warn(
        `[LocalAPI] could not unload the ${steps[index][0]} model:`,
        result.reason
      )
  })
  if (paused.length > 0) {
    const { pausedHelperModels, setPausedHelperModels } =
      useLocalApiServer.getState()
    setPausedHelperModels([...new Set([...pausedHelperModels, ...paused])])
  }
}

/**
 * The server is up again: switch back on the embedding and decision models
 * its turn-off switched off, unless their model was removed meanwhile. They
 * start on the first request. Best effort, like the turn-off.
 */
export async function resumeServedHelperModels(
  hub: ServiceHub = getServiceHub()
): Promise<void> {
  const { pausedHelperModels, setPausedHelperModels } =
    useLocalApiServer.getState()
  if (pausedHelperModels.length === 0) return
  setPausedHelperModels([])
  await Promise.all(
    pausedHelperModels.map(async (kind) => {
      try {
        const service = kind === 'embedding' ? hub.embedding() : hub.decision()
        const { config } = await service.getConfig()
        if (config.model_path) await service.setConfig({ enabled: true })
      } catch (error) {
        console.warn(`[LocalAPI] could not resume the ${kind} model:`, error)
      }
    })
  )
}

/**
 * Stop the server, then the models it served. Rethrows a failed stop (the
 * status is already back to 'stopped'), and the models stay as they were.
 */
export async function turnOffLocalApiServer(
  hub: ServiceHub = getServiceHub()
): Promise<void> {
  await setLocalApiServerRunning(false)
  await unloadServedModels(hub)
}
