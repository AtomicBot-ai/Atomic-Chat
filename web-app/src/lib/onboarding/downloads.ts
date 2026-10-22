import { EngineManager } from '@janhq/core'
import { toast } from 'sonner'

import {
  useDownloadStore,
  type DownloadRequestOrigin,
} from '@/hooks/useDownloadStore'
import {
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import { sanitizeMlxId } from '@/lib/hub-installed'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import type { ServiceHub } from '@/services'
import type { LocalModelCandidate } from '@/services/models/localScan'
import type { CatalogModel } from '@/services/models/types'
import { markSilentImport } from '@/utils/backgroundImports'

/**
 * The id an MLX catalog model is downloaded and registered under: the last
 * path segment, sanitized the MLX engine's way (dots survive).
 */
export function mlxModelId(catalog: CatalogModel): string {
  return sanitizeMlxId(
    catalog.model_name.split('/').pop() ?? catalog.model_name
  )
}

/**
 * Downloads an MLX catalog model through the MLX engine: the first
 * `.safetensors` file of the repository as the model, everything else beside
 * it. The same steps as `MlxModelDownloadAction`, for the setup surfaces.
 *
 * Resolves when the download is over: `true` once the engine has the model,
 * `false` when it failed or was cancelled. A failure that is not a
 * cancellation is reported in a toast. Callers that only start it `void` it.
 */
export async function startMlxCatalogDownload(
  catalog: CatalogModel,
  {
    serviceHub,
    huggingfaceToken,
    requestOrigin = 'standalone',
  }: {
    serviceHub: ServiceHub
    huggingfaceToken?: string
    requestOrigin?: DownloadRequestOrigin
  }
): Promise<boolean> {
  const store = useDownloadStore.getState()
  const mlxId = mlxModelId(catalog)
  const modelPath = `${catalog.developer}/${catalog.model_name.split('/').pop()}`
  const resume = store.resumableDownloads.has(mlxId)

  store.clearResumableDownload(mlxId)
  store.addLocalDownloadingModel(mlxId)
  store.setDownloadOrigin(mlxId, catalog.model_name, requestOrigin)

  try {
    const repoInfo = await serviceHub
      .models()
      .fetchHuggingFaceRepo(modelPath, huggingfaceToken)

    if (!repoInfo?.siblings?.length) {
      throw new Error('Failed to fetch repository files')
    }

    const modelFiles = repoInfo.siblings
    const mainSafetensorsFile = modelFiles.find((f) =>
      f.rfilename.toLowerCase().endsWith('.safetensors')
    )
    if (!mainSafetensorsFile) {
      throw new Error('No safetensors file found in repository')
    }

    const engine = EngineManager.instance().get('mlx')
    if (!engine) throw new Error('MLX engine not found')

    const modelUrl = `https://huggingface.co/${modelPath}/resolve/main/${mainSafetensorsFile.rfilename}`
    const extraFiles = modelFiles
      .filter((f) => f.rfilename !== mainSafetensorsFile.rfilename)
      .map((file) => ({
        url: `https://huggingface.co/${modelPath}/resolve/main/${file.rfilename}`,
        filename: file.rfilename,
      }))

    // `await` is load-bearing: without it the rejection escapes the catch and
    // the download fails with no toast and a row stuck in "downloading".
    await engine.import(mlxId, {
      modelPath: modelUrl,
      files: extraFiles,
      resume,
    })
    return true
  } catch (error) {
    console.error('Error downloading MLX model:', error)
    const after = useDownloadStore.getState()
    after.markResumableDownload(mlxId)
    after.removeLocalDownloadingModel(mlxId)
    after.clearDownloadOrigin(mlxId)
    if (
      wasDownloadCancellationRequested(mlxId) ||
      isDownloadCancellationError(error)
    ) {
      return false
    }
    toast.error('Failed to download MLX model', {
      description: extractModelErrorMessage(error),
    })
    return false
  }
}

/** The engine a model found on disk is imported into. */
export function providerForCandidate(
  candidate: Pick<LocalModelCandidate, 'format'>
): string {
  return candidate.format === 'mlx' ? 'mlx' : LOCAL_LLAMACPP_PROVIDER
}

/**
 * Adds models found on disk (LM Studio, Ollama, the Hugging Face cache) to the
 * library without loading or selecting any of them, then hands the refreshed
 * provider list to `onProviders` once every import settled — so they appear
 * even when the screen that started them has moved on.
 */
export function importCandidatesInBackground(
  candidates: readonly LocalModelCandidate[],
  {
    serviceHub,
    onProviders,
  }: {
    serviceHub: ServiceHub
    onProviders: (providers: ModelProvider[]) => void
  }
): void {
  const runnable = candidates.filter((candidate) => candidate.runnable)
  if (runnable.length === 0) return
  const imports = runnable.map((candidate) => {
    const engine = EngineManager.instance().get(providerForCandidate(candidate))
    if (!engine) return Promise.resolve()
    // Marked silent so DataProvider's import handler never auto-launches it.
    markSilentImport(candidate.id)
    return engine
      .import(candidate.id, {
        modelPath: candidate.path,
        mmprojPath: candidate.mmprojPath,
        source: candidate.source,
      })
      .catch(() => {})
  })
  void Promise.allSettled(imports).then(async () => {
    try {
      onProviders(await serviceHub.providers().getProviders())
    } catch {
      // Best-effort: a later provider refresh will surface them.
    }
  })
}
