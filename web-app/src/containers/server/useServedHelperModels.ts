import { useEffect } from 'react'

import { useHardware } from '@/hooks/useHardware'
import {
  useLocalApiServer,
  type ServedHelperKind,
} from '@/hooks/useLocalApiServer'
import { useLocalEmbeddingModels } from '@/hooks/useEmbeddingModel'
import { useServiceHub } from '@/hooks/useServiceHub'
import { DECISION_ENGINE_UI } from '@/lib/decision/engine'
import {
  activateDecisionModel,
  isActiveDecisionModel,
  stopDecisionModel,
} from '@/lib/decision/models'
import { isDecisionHostSupported } from '@/lib/decision/platform'
import { isEmbeddingHostSupported } from '@/lib/embedding/engine'
import {
  activateEmbeddingModel,
  activateLocalEmbeddingModel,
  isActiveEmbeddingModel,
  isActiveLocalEmbeddingModel,
  stopEmbeddingModel,
} from '@/lib/embedding/models'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import type { DecisionEngine } from '@/services/decision-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { raiseLocalApiServerForMediaModel } from '@/utils/localApiServerControl'

import type { ServerSelectOption } from './ServerPageParts'

/** The choice that serves no model of the kind. */
export const NO_HELPER_MODEL = 'none'

/**
 * The embedding or decision models the server can serve beside its chat
 * model: the downloaded ones, which one it serves now, and how to change it.
 * One model of each kind runs at a time, so choosing one replaces the other.
 */
export type ServedHelperModels = {
  /** This desktop has a core and an engine build for the kind. */
  supported: boolean
  options: ServerSelectOption[]
  /** The model served now, or {@link NO_HELPER_MODEL}. */
  active: string
  /**
   * Start the chosen model (or switch the kind off), and bring the server up
   * with it as for a model started in the Hub. Rejects with the core's error.
   */
  apply: (value: string) => Promise<void>
}

/**
 * A choice made here replaces the one a server turn-off put aside: the next
 * start must not switch the old model back on (`resumeServedHelperModels`).
 */
function forgetPaused(kind: ServedHelperKind) {
  const { pausedHelperModels, setPausedHelperModels } =
    useLocalApiServer.getState()
  if (pausedHelperModels.includes(kind))
    setPausedHelperModels(
      pausedHelperModels.filter((paused) => paused !== kind)
    )
}

/** `catalog:<id>` / `local:<id>`: a llama.cpp model may carry a catalog id. */
const splitChoice = (value: string) => {
  const at = value.indexOf(':')
  return { source: value.slice(0, at), id: value.slice(at + 1) }
}

/**
 * Embedding models, served at `/v1/embeddings`: the Hub's downloads and the
 * llama.cpp models flagged as embedding GGUFs.
 */
export function useServedEmbeddingModels(): ServedHelperModels {
  const apiSupported = useServiceHub().embedding().isSupported()
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)
  const supported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    apiSupported &&
    isEmbeddingHostSupported(cpuArch)

  const catalog = useEmbeddingStore((s) => s.catalog)
  const installed = useEmbeddingStore((s) => s.installed)
  const config = useEmbeddingStore((s) => s.config)
  const local = useLocalEmbeddingModels()

  useEffect(() => {
    if (!supported) return
    return useEmbeddingStore.getState().bind()
  }, [supported])

  const models = catalog.models.filter((model) => installed[model.id])
  const options = [
    ...models.map((model) => ({
      value: `catalog:${model.id}`,
      label: model.name,
    })),
    ...local.map((model) => ({
      value: `local:${model.id}`,
      label: model.name,
    })),
  ]

  const activeCatalog = models.find((model) =>
    isActiveEmbeddingModel(config, model)
  )
  const activeLocal = local.find((model) =>
    isActiveLocalEmbeddingModel(config, model)
  )
  const active = !config?.enabled
    ? NO_HELPER_MODEL
    : activeCatalog
      ? `catalog:${activeCatalog.id}`
      : activeLocal
        ? `local:${activeLocal.id}`
        : NO_HELPER_MODEL

  const apply = async (value: string) => {
    forgetPaused('embedding')
    if (value === NO_HELPER_MODEL) {
      await stopEmbeddingModel()
    } else {
      const { source, id } = splitChoice(value)
      const fromCatalog =
        source === 'catalog' ? models.find((model) => model.id === id) : null
      const fromLocal =
        source === 'local' ? local.find((model) => model.id === id) : null
      if (fromCatalog) await activateEmbeddingModel(fromCatalog)
      else if (fromLocal) await activateLocalEmbeddingModel(fromLocal)
      else return
      await raiseLocalApiServerForMediaModel()
    }
    await useEmbeddingStore.getState().refresh()
  }

  return { supported, options, active, apply }
}

/**
 * Decision models, served at `/v1/systemone` and `/v1/router/score`: the
 * Hub's downloads for the engines this desktop has (TurboQuant behind its
 * platform flag, stock llama.cpp).
 */
export function useServedDecisionModels(): ServedHelperModels {
  const apiSupported = useServiceHub().decision().isSupported()
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)
  const runsOn = (engine: DecisionEngine) =>
    isDecisionHostSupported(cpuArch, engine) &&
    (engine !== 'llamacpp' ||
      PlatformFeatures[PlatformFeature.TURBOQUANT_ENGINE])
  const supported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    apiSupported &&
    (runsOn('llamacpp') || runsOn('llamacpp-upstream'))

  const catalog = useDecisionStore((s) => s.catalog)
  const installed = useDecisionStore((s) => s.installed)
  const config = useDecisionStore((s) => s.config)

  useEffect(() => {
    if (!supported) return
    return useDecisionStore.getState().bind()
  }, [supported])

  const models = catalog.models.filter(
    (model) => installed[model.id] && runsOn(model.engine)
  )
  const options = models.map((model) => ({
    value: model.id,
    label: `${model.name} · ${DECISION_ENGINE_UI[model.engine].name}`,
  }))
  const activeModel = config?.enabled
    ? models.find((model) => isActiveDecisionModel(config, model))
    : undefined

  const apply = async (value: string) => {
    forgetPaused('decision')
    if (value === NO_HELPER_MODEL) {
      await stopDecisionModel()
    } else {
      const model = models.find((candidate) => candidate.id === value)
      if (!model) return
      await activateDecisionModel(model)
      await raiseLocalApiServerForMediaModel()
    }
    await useDecisionStore.getState().refresh()
  }

  return {
    supported,
    options,
    active: activeModel?.id ?? NO_HELPER_MODEL,
    apply,
  }
}
