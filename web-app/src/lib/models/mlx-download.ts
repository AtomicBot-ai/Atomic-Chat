/** An MLX request records the complete selected tree before the engine opens a file. */
import {
  beginAtomicModelPreparation,
  readAtomicDownloadPlan,
  saveAtomicDownloadPlan,
} from '@janhq/core'
import type { ModelsService } from '@/services/models/types'
import { preflightDownloadDiskSpace } from '@/services/models/downloadPreflight'

export async function mlxDownloadOptions(
  service: ModelsService,
  modelId: string,
  repo: string,
  resume: boolean,
  token?: string
) {
  const id = `request:mlx/${modelId}`
  let plan = resume ? readAtomicDownloadPlan(id) : undefined
  if (resume && !plan)
    throw new Error(
      'This download has no recorded model plan. Start a new download; partial files were kept.'
    )
  if (!plan) {
    const preparation = beginAtomicModelPreparation(
      `mlx/${modelId.replace(/[^A-Za-z0-9_/:-]/g, '_')}`
    )
    try {
      const meta = await service.fetchHuggingFaceRepo(
        repo,
        token,
        undefined,
        preparation.signal
      )
      preparation.signal.throwIfAborted()
      if (!meta || !/^[0-9a-f]{40}$/.test(meta.sha) || !meta.siblings?.length)
        throw new Error('Hugging Face did not supply an immutable MLX tree')
      const revision = meta.sha
      plan = {
        version: 1,
        files: meta.siblings.map((file) => {
          const path = file.rfilename
          const size = file.lfs?.size ?? file.size
          if (
            path
              .split(/[\\/]/)
              .some((part) => !part || part === '.' || part === '..') ||
            !Number.isSafeInteger(size) ||
            size! < 0
          )
            throw new Error(`Invalid MLX file metadata: ${path}`)
          return {
            url: `https://huggingface.co/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`,
            save_path: path,
            size: size!,
            ...(file.lfs?.sha256 ? { sha256: file.lfs.sha256 } : {}),
            source: { repo, revision, path },
            purpose: path.endsWith('.safetensors')
              ? 'weights'
              : 'configuration',
          }
        }),
      }
      const weights = plan.files.find((file) =>
        file.source?.path.endsWith('.safetensors')
      )
      if (!weights) throw new Error('No safetensors file found in repository')
      const refusal = await preflightDownloadDiskSpace({
        modelPath: weights.url,
        modelSize: plan.files.reduce((total, file) => total + file.size!, 0),
      })
      if (refusal)
        throw new Error(
          `Not enough disk space for this MLX model: ${refusal.needed} bytes needed, ${refusal.available} available.`
        )
      preparation.signal.throwIfAborted()
      saveAtomicDownloadPlan(id, plan)
    } finally {
      preparation.finish()
    }
  }
  const main = plan.files.find((file) =>
    file.source?.path.toLowerCase().endsWith('.safetensors')
  )
  if (!main) throw new Error('No safetensors file found in repository')
  return {
    modelPath: main.url,
    modelSize: main.size ?? undefined,
    modelSha256: main.sha256 ?? undefined,
    files: plan.files
      .filter((file) => file !== main)
      .map((file) => ({
        url: file.url,
        filename: file.source!.path,
        size: file.size ?? undefined,
        sha256: file.sha256 ?? undefined,
      })),
    resume,
  }
}
