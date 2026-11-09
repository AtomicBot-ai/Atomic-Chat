/**
 * Decision models on disk and in the core.
 *
 * A model is downloaded file by file from its pinned Hugging Face revision
 * into `<dataFolder>/decision/models/<id>/`. A TurboQuant model is a laya
 * checkpoint folder: the core runs it with `llama-server --decision -m
 * <folder>`, and the engine converts the folder once into
 * `<dataFolder>/decision/gguf-cache` (the core prunes that cache). A stock
 * llama.cpp model is a GGUF (plus a projector for one that reads images): the
 * core finds `<arch>.decision.type` in it and starts the upstream build. Both
 * serve `/v1/systemone` behind the Local API Server. Decision models never
 * live under `llamacpp/models`: they are not chat models and must not surface
 * in the model picker or in `/v1/models`.
 */

import { fs } from '@janhq/core'

import { getServiceHub } from '@/hooks/useServiceHub'
import {
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  emitTransferValidationFailed,
  isTransferValidationError,
  sanitizeTaskId,
  transferFiles,
  type TransferItem,
} from '@/services/diffusion/transfer'
import {
  decisionFileUrl,
  decisionModelFile,
  decisionProjectorFile,
  type DecisionCatalogFile,
  type DecisionCatalogModel,
} from '@/services/decision-catalog-registry'
import type { DecisionConfig, DecisionStatus } from '@/services/decision/types'

export const DECISION_MODELS_DIR = 'decision/models'

/** The model's folder; relative, the core resolves it against the data folder. */
export const decisionModelDir = (id: string): string =>
  `${DECISION_MODELS_DIR}/${id}`

/** What the core is pointed at: the checkpoint folder, or a GGUF model's `-m` file. */
export const decisionModelPath = (model: DecisionCatalogModel): string => {
  const file = decisionModelFile(model)
  return file
    ? `${decisionModelDir(model.id)}/${file.path}`
    : decisionModelDir(model.id)
}

/**
 * How long a start may take: a checkpoint is a few hundred MB on the CPU, a
 * stock llama.cpp model up to 20 GB read from disk onto the GPU.
 */
export const decisionStartupTimeoutSecs = (
  model: DecisionCatalogModel
): number => (model.engine === 'llamacpp-upstream' ? 600 : 60)

const DECISION_TASK_PREFIX = 'decision-'

/** Download panel row and Rust task id. */
export const decisionDownloadTaskId = (id: string): string =>
  sanitizeTaskId(`${DECISION_TASK_PREFIX}${id}`)

export const isDecisionDownloadTaskId = (taskId: string): boolean =>
  taskId.startsWith(DECISION_TASK_PREFIX)

/** `file://` paths are resolved by the Rust fs commands against the data folder. */
const dataPath = (relative: string): string => `file://${relative}`

const exists = async (relative: string): Promise<boolean> => {
  try {
    return Boolean(await fs.existsSync(dataPath(relative)))
  } catch {
    return false
  }
}

/**
 * Files of `model` not on disk yet. The downloader writes each file under a
 * temporary name and renames it only after its size and sha256 check, so a
 * file that exists is a verified one.
 */
export async function missingDecisionFiles(
  model: DecisionCatalogModel
): Promise<DecisionCatalogFile[]> {
  const dir = decisionModelDir(model.id)
  const present = await Promise.all(
    model.files.map((file) => exists(`${dir}/${file.path}`))
  )
  return model.files.filter((_, index) => !present[index])
}

export async function isDecisionModelInstalled(
  model: DecisionCatalogModel
): Promise<boolean> {
  return (await missingDecisionFiles(model)).length === 0
}

export type DecisionDownloadOptions = {
  hfToken?: string
  resume?: boolean
}

/**
 * Download what `model` is still missing, under `decisionDownloadTaskId`, so
 * the standard download panel, the proxy setting and the Rust size/sha256
 * verification all apply. Resolves once every file is on disk.
 */
export async function downloadDecisionModel(
  model: DecisionCatalogModel,
  opts: DecisionDownloadOptions = {}
): Promise<void> {
  const missing = await missingDecisionFiles(model)
  if (missing.length === 0) return
  const taskId = decisionDownloadTaskId(model.id)
  const proxy = downloadProxyConfig()
  const total = missing.reduce((sum, file) => sum + file.bytes, 0)
  const dir = decisionModelDir(model.id)
  const items: TransferItem[] = missing.map((file) => ({
    url: decisionFileUrl(model, file),
    save_path: `${dir}/${file.path}`,
    ...(proxy ? { proxy } : {}),
    sha256: file.sha256,
    size: file.bytes,
    model_id: taskId,
  }))
  emitTransferProgress(taskId, 'Model', 0, total)
  try {
    await transferFiles(items, taskId, {
      resume: opts.resume ?? false,
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      onProgress: (transferred, size) =>
        emitTransferProgress(taskId, 'Model', transferred, size),
    })
  } catch (error) {
    if (isTransferValidationError(error)) {
      emitTransferValidationFailed(taskId, error)
    } else {
      emitTransferError(taskId, 'Model', error)
    }
    throw error
  }
  emitTransferSuccess(taskId, 'Model', total)
}

/** Whether the core is configured to run `model` (running or not). */
export const isActiveDecisionModel = (
  config: Pick<DecisionConfig, 'model_path'> | null,
  model: DecisionCatalogModel
): boolean => config?.model_path === decisionModelPath(model)

/**
 * Point the core at `model` and start it; resolves once the engine is ready.
 * A failure rejects with the core's `{code, message, details?}`. Another
 * model that was running is replaced: one decision model runs at a time.
 */
export async function activateDecisionModel(
  model: DecisionCatalogModel
): Promise<DecisionStatus> {
  const decision = getServiceHub().decision()
  const projector = decisionProjectorFile(model)
  const upstream = model.engine === 'llamacpp-upstream'
  await decision.setConfig({
    enabled: true,
    model_path: decisionModelPath(model),
    model_id: model.id,
    // Cleared for a model without them, so a previous model's never leaks in.
    mmproj_path: projector
      ? `${decisionModelDir(model.id)}/${projector.path}`
      : '',
    ctx_size: upstream ? model.context : 0,
    startup_timeout_secs: decisionStartupTimeoutSecs(model),
  })
  return decision.load()
}

/**
 * Start the configured decision model again, after a start that timed out or
 * failed. The core checks again every engine it could not check before.
 */
export async function retryDecisionModel(): Promise<DecisionStatus> {
  return getServiceHub().decision().load()
}

/** Stop the decision model and keep it from starting on the next call. */
export async function stopDecisionModel(): Promise<void> {
  await getServiceHub().decision().setConfig({ enabled: false })
}

/**
 * Remove `model` from disk. An active model is first turned off and cleared
 * from the core's settings: the process must let go of the folder (Windows
 * cannot delete a mapped file), and the core then drops its cached GGUF.
 */
export async function deleteDecisionModel(
  model: DecisionCatalogModel,
  config: Pick<DecisionConfig, 'model_path'> | null
): Promise<void> {
  if (isActiveDecisionModel(config, model)) {
    await getServiceHub()
      .decision()
      .setConfig({
        enabled: false,
        model_path: '',
        model_id: '',
        mmproj_path: '',
      })
  }
  const dir = decisionModelDir(model.id)
  if (await exists(dir)) await fs.rm(dataPath(dir))
}

/**
 * A decision model the catalog does not name, which the user already has: a
 * decision GGUF among the llama.cpp models (downloaded through the Hub's
 * search, or imported), or weights put by hand into a folder of
 * `decision/models` that no catalog model owns. The core runs either from its
 * path, as it runs a catalog model.
 */
export type LocalDecisionModel = {
  /** Selection key; a llama.cpp id may carry a catalog id's name. */
  key: string
  /** `-a`: the name API clients pass as `model`. */
  id: string
  name: string
  source: 'llamacpp' | 'folder'
  /** A GGUF or a laya checkpoint folder; relative to the data folder, or absolute. */
  model_path: string
  /** Empty for a model without a projector. */
  mmproj_path: string
}

export const localDecisionKey = (
  source: LocalDecisionModel['source'],
  id: string
): string => `${source}:${id}`

const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

const listDir = async (path: string): Promise<string[]> => {
  try {
    return ((await fs.readdirSync(path)) as string[] | undefined) ?? []
  } catch {
    return []
  }
}

/** The first shard of a split GGUF, or the file itself. */
const isFirstShardOrWhole = (file: string): boolean => {
  const shard = /-(\d+)-of-\d+\.gguf$/i.exec(file)
  return !shard || Number(shard[1]) === 1
}

/**
 * The models in `decision/models` folders the catalog does not own: a GGUF
 * (its projector beside it when the folder has one) or a laya checkpoint
 * folder. Whether the file really is a decision model is the core's to say on
 * start; a folder with neither is left out.
 */
export async function readDecisionFolderModels(
  catalogIds: ReadonlySet<string>
): Promise<LocalDecisionModel[]> {
  const dirs = await listDir(dataPath(DECISION_MODELS_DIR))
  const models = await Promise.all(
    dirs.map(async (dir): Promise<LocalDecisionModel | null> => {
      const name = baseName(dir)
      if (catalogIds.has(name)) return null
      const files = (await listDir(dir)).map(baseName)
      const base = decisionModelDir(name)
      const folder = {
        key: localDecisionKey('folder', name),
        id: name,
        name,
        source: 'folder' as const,
      }
      if (files.includes('rl_agent_config.json'))
        return { ...folder, model_path: base, mmproj_path: '' }
      const ggufs = files.filter((file) => /\.gguf$/i.test(file)).sort()
      const projector = ggufs.find((file) => /mmproj/i.test(file))
      const weights = ggufs.find(
        (file) => !/mmproj/i.test(file) && isFirstShardOrWhole(file)
      )
      if (!weights) return null
      return {
        ...folder,
        model_path: `${base}/${weights}`,
        mmproj_path: projector ? `${base}/${projector}` : '',
      }
    })
  )
  return models.filter((model): model is LocalDecisionModel => model !== null)
}

export const isActiveLocalDecisionModel = (
  config: Pick<DecisionConfig, 'model_path'> | null,
  model: LocalDecisionModel
): boolean => config?.model_path === model.model_path

/**
 * Point the core at a model the catalog does not name and start it. The
 * context is the core's default for the file: there is no catalog entry to
 * name one. A stock llama.cpp model may take a while to read onto the GPU.
 */
export async function activateLocalDecisionModel(
  model: LocalDecisionModel
): Promise<DecisionStatus> {
  const decision = getServiceHub().decision()
  await decision.setConfig({
    enabled: true,
    model_path: model.model_path,
    model_id: model.id,
    mmproj_path: model.mmproj_path,
    ctx_size: 0,
    startup_timeout_secs: 600,
  })
  return decision.load()
}
