/**
 * Models Service Types
 */

import {
  SessionInfo,
  modelInfo,
  ThreadMessage,
  UnloadResult,
  type ModelLoadOptions,
} from '@janhq/core'
import { Model as CoreModel } from '@janhq/core'

// Types for model catalog
export interface ModelQuant {
  model_id: string
  path: string
  file_size: string
}

export interface MMProjModel {
  model_id: string
  path: string
  file_size: string
}

export interface SafetensorsFile {
  model_id: string
  path: string
  file_size: string
  sha256?: string
}

export interface CatalogModel {
  model_name: string
  description: string
  library_name?: string
  developer?: string
  downloads: number
  likes?: number
  num_quants?: number
  quants?: ModelQuant[]
  mmproj_models?: MMProjModel[]
  num_mmproj?: number
  safetensors_files?: SafetensorsFile[]
  num_safetensors?: number
  created_at?: string
  last_modified?: string
  readme?: string
  tools?: boolean
  is_mlx?: boolean
}

export type ModelCatalog = CatalogModel[]

/**
 * Why `pullModelWithMetadata` did not start a download. Returned, not thrown:
 * most callers fire-and-forget the pull, and a refusal is not a failure to
 * report — the choke point has already told the user and cleared the
 * pre-download state it set.
 */
export interface DownloadRefusal {
  kind: 'disk_full'
  /** Bytes the drive would need free: the files plus the downloader's headroom. */
  needed: number
  /** Bytes the drive has free. */
  available: number
}

/** Hugging Face's own orders for a listing (`sort=` on `/api/models`). */
export type HuggingFaceFeedSort =
  | 'trending'
  | 'downloads'
  | 'likes'
  | 'lastModified'

export type HuggingFaceFeedFormat = 'gguf' | 'mlx'

export type HuggingFaceFeedParams = {
  format: HuggingFaceFeedFormat
  sort: HuggingFaceFeedSort
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string | null
  limit?: number
  hfToken?: string
}

export type HuggingFaceFeedPage = {
  models: CatalogModel[]
  nextCursor: string | null
}

// HuggingFace repository information
export interface HuggingFaceRepo {
  id: string
  modelId: string
  sha: string
  downloads: number
  likes: number
  library_name?: string
  tags: string[]
  pipeline_tag?: string
  createdAt: string
  last_modified: string
  private: boolean
  disabled: boolean
  gated: boolean | string
  author: string
  cardData?: {
    license?: string
    language?: string[]
    datasets?: string[]
    metrics?: string[]
  }
  siblings?: Array<{
    rfilename: string
    size?: number
    blobId?: string
    lfs?: {
      sha256: string
      size: number
      pointerSize: number
    }
  }>
  readme?: string
}

export interface GgufMetadata {
  version: number
  tensor_count: number
  metadata: Record<string, string>
}

export interface ModelValidationResult {
  isValid: boolean
  error?: string
  metadata?: GgufMetadata
}

export type PreflightReason =
  | 'AUTH_REQUIRED'
  | 'LICENSE_NOT_ACCEPTED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN'

export interface ModelsService {
  getModel(modelId: string): Promise<modelInfo | undefined>
  fetchModels(): Promise<modelInfo[]>
  fetchModelCatalog(): Promise<ModelCatalog>
  fetchHuggingFaceRepo(
    repoId: string,
    hfToken?: string
  ): Promise<HuggingFaceRepo | null>
  /**
   * Long-tail fallback: query HF for the top-N candidates matching a free
   * text term, scored via the same heuristic used by `fetchHuggingFaceRepo`.
   * Returns lightweight `CatalogModel`-shaped entries (no per-repo detail
   * fetch) so the Hub UI can render a "From Hugging Face" section without
   * paying the cost of N follow-up requests. Callers should drill into
   * `fetchHuggingFaceRepo` only when the user actually picks a result.
   */
  searchHuggingFaceCandidates(
    query: string,
    hfToken?: string,
    limit?: number
  ): Promise<CatalogModel[]>
  /**
   * One page of Hugging Face's own listing of a format, in one of its sort
   * orders — the Hub's long tail under the curated picks. Entries are
   * lightweight (no quants: the list endpoint carries no file sizes); the
   * page's `nextCursor` feeds the next call, `null` when the listing ends.
   */
  listHuggingFaceFeed(
    params: HuggingFaceFeedParams
  ): Promise<HuggingFaceFeedPage>
  convertHfRepoToCatalogModel(repo: HuggingFaceRepo): CatalogModel
  updateModel(modelId: string, model: Partial<CoreModel>): Promise<void>
  pullModel(
    id: string,
    modelPath: string,
    modelSha256?: string,
    modelSize?: number,
    mmprojPath?: string,
    mmprojSha256?: string,
    mmprojSize?: number,
    resume?: boolean
  ): Promise<void>
  pullModelWithMetadata(
    id: string,
    modelPath: string,
    mmprojPath?: string,
    hfToken?: string,
    skipVerification?: boolean,
    resume?: boolean
  ): Promise<DownloadRefusal | undefined>
  abortDownload(id: string): Promise<void>
  deleteModel(id: string, provider?: string): Promise<void>
  getActiveModels(provider?: string): Promise<string[]>
  stopModel(model: string, provider?: string): Promise<UnloadResult | undefined>
  stopAllModels(): Promise<void>
  /**
   * Unload every locally loaded model except `(providerName, modelId)`.
   * Lets a switch drop stray copies of a model living in another engine
   * without touching the one that is currently serving requests.
   */
  stopAllModelsExcept(modelId: string, providerName: string): Promise<void>
  startModel(
    provider: ProviderObject,
    model: string,
    bypassAutoUnload?: boolean,
    options?: ModelLoadOptions
  ): Promise<SessionInfo | undefined>
  /**
   * Stop a load of `model` on `provider` that has not finished (ATO-530).
   * Resolves `true` when the engine had one to stop; that load then rejects
   * with `MODEL_LOAD_CANCELLED_CODE`.
   */
  cancelModelLoad(provider: string, model: string): Promise<boolean>
  isToolSupported(modelId: string): Promise<boolean>
  checkMmprojExistsAndUpdateOffloadMMprojSetting(
    modelId: string,
    updateProvider?: (
      providerName: string,
      data: Partial<ModelProvider>
    ) => void,
    getProviderByName?: (providerName: string) => ModelProvider | undefined
  ): Promise<{ exists: boolean; settingsUpdated: boolean }>
  checkMmprojExists(modelId: string): Promise<boolean>
  isModelSupported(
    modelPath: string,
    ctxSize?: number
  ): Promise<'RED' | 'YELLOW' | 'GREEN' | 'GREY'>
  validateGgufFile(filePath: string): Promise<ModelValidationResult>
  getTokensCount(modelId: string, messages: ThreadMessage[]): Promise<number>
}
