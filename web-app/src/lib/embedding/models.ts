/**
 * Embedding models on disk and in the core.
 *
 * A catalog model is downloaded file by file from its pinned Hugging Face
 * revision into `<dataFolder>/embedding/models/<id>/`: one GGUF, plus a
 * projector for a model that reads images or audio. The core runs it with
 * stock llama.cpp (`llama-server --embedding`) and serves it on the Local API
 * Server's `/v1/embeddings` under the catalog id. Catalog models never live
 * under `llamacpp/models`: they are not chat models and must not surface in
 * the model picker.
 *
 * An embedding GGUF the user already has as a llama.cpp model (`model.yml`
 * under `llamacpp/models/<id>`, flagged `embedding` by the extension) can be
 * served the same way, from where it lies.
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
  embeddingFileUrl,
  embeddingModelFile,
  embeddingProjectorFile,
  type EmbeddingCatalogFile,
  type EmbeddingCatalogModel,
} from '@/services/embedding-catalog-registry'
import type {
  EmbeddingConfig,
  EmbeddingStatus,
} from '@/services/embedding/types'

export const EMBEDDING_MODELS_DIR = 'embedding/models'

/** How long a start may take: the weights are mapped and, with a projector, its encoders warmed. */
export const EMBEDDING_STARTUP_TIMEOUT_SECS = 300

/** The model's folder; relative, the core resolves it against the data folder. */
export const embeddingModelDir = (id: string): string =>
  `${EMBEDDING_MODELS_DIR}/${id}`

/** What the core is pointed at: the model's `-m` file. */
export const embeddingModelPath = (model: EmbeddingCatalogModel): string =>
  `${embeddingModelDir(model.id)}/${embeddingModelFile(model).path}`

/** The model's `--mmproj` file, or `''` for a text-only model. */
export const embeddingProjectorPath = (
  model: EmbeddingCatalogModel
): string => {
  const projector = embeddingProjectorFile(model)
  return projector ? `${embeddingModelDir(model.id)}/${projector.path}` : ''
}

const EMBEDDING_TASK_PREFIX = 'embedding-'

/** Download panel row and Rust task id. */
export const embeddingDownloadTaskId = (id: string): string =>
  sanitizeTaskId(`${EMBEDDING_TASK_PREFIX}${id}`)

export const isEmbeddingDownloadTaskId = (taskId: string): boolean =>
  taskId.startsWith(EMBEDDING_TASK_PREFIX)

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
export async function missingEmbeddingFiles(
  model: EmbeddingCatalogModel
): Promise<EmbeddingCatalogFile[]> {
  const dir = embeddingModelDir(model.id)
  const present = await Promise.all(
    model.files.map((file) => exists(`${dir}/${file.path}`))
  )
  return model.files.filter((_, index) => !present[index])
}

export async function isEmbeddingModelInstalled(
  model: EmbeddingCatalogModel
): Promise<boolean> {
  return (await missingEmbeddingFiles(model)).length === 0
}

export type EmbeddingDownloadOptions = {
  hfToken?: string
  resume?: boolean
}

/**
 * Download what `model` is still missing (the GGUF and its projector), under
 * `embeddingDownloadTaskId`, so the standard download panel, the proxy
 * setting and the Rust size/sha256 verification all apply. Resolves once
 * every file is on disk.
 */
export async function downloadEmbeddingModel(
  model: EmbeddingCatalogModel,
  opts: EmbeddingDownloadOptions = {}
): Promise<void> {
  const missing = await missingEmbeddingFiles(model)
  if (missing.length === 0) return
  const taskId = embeddingDownloadTaskId(model.id)
  const proxy = downloadProxyConfig()
  const total = missing.reduce((sum, file) => sum + file.bytes, 0)
  const dir = embeddingModelDir(model.id)
  const items: TransferItem[] = missing.map((file) => ({
    url: embeddingFileUrl(model, file),
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
export const isActiveEmbeddingModel = (
  config: Pick<EmbeddingConfig, 'model_path'> | null,
  model: EmbeddingCatalogModel
): boolean => config?.model_path === embeddingModelPath(model)

/**
 * Point the core at `model` and start it; resolves once the engine is ready.
 * A failure rejects with the core's `{code, message, details?}`. Another
 * model that was running is replaced: one embedding model runs at a time.
 */
export async function activateEmbeddingModel(
  model: EmbeddingCatalogModel
): Promise<EmbeddingStatus> {
  const embedding = getServiceHub().embedding()
  await embedding.setConfig({
    enabled: true,
    model_path: embeddingModelPath(model),
    // Cleared for a model without one, so a previous model's never leaks in.
    mmproj_path: embeddingProjectorPath(model),
    model_id: model.id,
    ctx_size: model.context,
    pooling: model.pooling,
    image_max_tokens: model.image_max_tokens ?? 0,
    startup_timeout_secs: EMBEDDING_STARTUP_TIMEOUT_SECS,
  })
  return embedding.load()
}

/** Stop the embedding model and keep it from starting on the next request. */
export async function stopEmbeddingModel(): Promise<void> {
  await getServiceHub().embedding().setConfig({ enabled: false })
}

/**
 * Remove `model` from disk. An active model is first turned off and cleared
 * from the core's settings: the process must let go of the files (Windows
 * cannot delete a mapped file).
 */
export async function deleteEmbeddingModel(
  model: EmbeddingCatalogModel,
  config: Pick<EmbeddingConfig, 'model_path'> | null
): Promise<void> {
  if (isActiveEmbeddingModel(config, model)) {
    await getServiceHub().embedding().setConfig({
      enabled: false,
      model_path: '',
      mmproj_path: '',
      model_id: '',
    })
  }
  const dir = embeddingModelDir(model.id)
  if (await exists(dir)) await fs.rm(dataPath(dir))
}

/**
 * An embedding GGUF the user already has as a llama.cpp model: its provider
 * id, and the paths its `model.yml` names (relative to the data folder, or
 * absolute — the core reads both).
 */
export type LocalEmbeddingModel = {
  id: string
  name: string
  model_path: string
  mmproj_path: string
}

type LocalModelYml = { model_path?: unknown; mmproj_path?: unknown }

/** Read `llamacpp/models/<id>/model.yml`; `null` when it is gone or names no file. */
export async function readLocalEmbeddingModel(
  id: string,
  name: string
): Promise<LocalEmbeddingModel | null> {
  try {
    const yml = await getServiceHub()
      .app()
      .readYaml<LocalModelYml>(`llamacpp/models/${id}/model.yml`)
    if (typeof yml?.model_path !== 'string' || !yml.model_path) return null
    return {
      id,
      name,
      model_path: yml.model_path,
      mmproj_path: typeof yml.mmproj_path === 'string' ? yml.mmproj_path : '',
    }
  } catch {
    return null
  }
}

export const isActiveLocalEmbeddingModel = (
  config: Pick<EmbeddingConfig, 'model_path'> | null,
  model: LocalEmbeddingModel
): boolean => config?.model_path === model.model_path

/**
 * Serve a llama.cpp model's GGUF as the embedding model, under its provider
 * id. Context, pooling and image budget are the model's own: there is no
 * catalog entry to name them.
 */
export async function activateLocalEmbeddingModel(
  model: LocalEmbeddingModel
): Promise<EmbeddingStatus> {
  const embedding = getServiceHub().embedding()
  await embedding.setConfig({
    enabled: true,
    model_path: model.model_path,
    mmproj_path: model.mmproj_path,
    model_id: model.id,
    ctx_size: 0,
    pooling: '',
    image_max_tokens: 0,
    startup_timeout_secs: EMBEDDING_STARTUP_TIMEOUT_SECS,
  })
  return embedding.load()
}
