/** Pure adapter shared by discovery and the canonical catalog's pinned file lists. */
import { sanitizeModelId } from '@/lib/utils'
import {
  ggufShardGroupKey,
  groupGgufShards,
  isNonWeightGgufFile,
  findCatalogModelForRecommendedRepo,
} from '@/lib/models'
import type { CatalogModel, HuggingFaceRepo } from './types'
import {
  atomicModelCatalogSnapshot,
  type AtomicModelCatalog,
} from '@janhq/core'

export function hfRepoToCatalogModel(repo: HuggingFaceRepo): CatalogModel {
  // Format file size helper
  const formatFileSize = (size?: number) => {
    if (!size) return 'Unknown size'
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
    return `${(size / 1024 ** 3).toFixed(1)} GB`
  }

  // Extract GGUF files from the repository siblings
  const ggufFiles =
    repo.siblings?.filter((file) =>
      file.rfilename.toLowerCase().endsWith('.gguf')
    ) || []

  // Keep only files that are runnable weights: drop the projectors, the MTP
  // heads, and everything else a repo ships alongside its quants (imatrix
  // dumps, DFlash/EAGLE drafts, vocab-only and audio-companion GGUFs) — none
  // of those load as a model, and offering them is a download the user has to
  // throw away.
  const regularGgufFiles = ggufFiles.filter(
    (file) =>
      !file.rfilename.toLowerCase().includes('mmproj') &&
      !isNonWeightGgufFile(file.rfilename)
  )

  const mmprojFiles = ggufFiles.filter((file) =>
    file.rfilename.toLowerCase().includes('mmproj')
  )

  // Convert regular GGUF files to quants format. A quant split across shards
  // is one downloadable variant, quoted at the size of the whole set.
  const quants = groupGgufShards(regularGgufFiles).map((shards) => {
    const first = shards[0]
    // Generate model_id from filename (remove .gguf extension, case-insensitive)
    const modelId = ggufShardGroupKey(first.rfilename).replace(/\.gguf$/i, '')
    const totalSize = shards.reduce(
      (sum, file) => sum + (file.lfs?.size ?? file.size ?? 0),
      0
    )

    return {
      model_id: `${repo.author}/${sanitizeModelId(modelId)}`,
      path: `https://huggingface.co/${repo.modelId}/resolve/${repo.sha}/${first.rfilename}`,
      file_size: formatFileSize(totalSize),
    }
  })

  // Convert mmproj files to mmproj_models format
  const mmprojModels = mmprojFiles.map((file) => {
    const modelId = file.rfilename.replace(/\.gguf$/i, '')

    return {
      model_id: sanitizeModelId(modelId),
      path: `https://huggingface.co/${repo.modelId}/resolve/${repo.sha}/${file.rfilename}`,
      file_size: formatFileSize(file.lfs?.size ?? file.size),
    }
  })

  // Extract safetensors files (MLX models)
  const safetensorsFiles =
    repo.siblings?.filter((file) =>
      file.rfilename.toLowerCase().endsWith('.safetensors')
    ) || []

  // Check if this repository has MLX model files (safetensors + associated files)
  const hasMlxFiles = repo.library_name === 'mlx' || repo.tags?.includes('mlx')

  const safetensorsModels = safetensorsFiles.map((file) => {
    // Generate model_id from filename (remove .safetensors extension, case-insensitive)
    const modelId = file.rfilename.replace(/\.safetensors$/i, '')

    return {
      model_id: sanitizeModelId(modelId),
      path: `https://huggingface.co/${repo.modelId}/resolve/${repo.sha}/${file.rfilename}`,
      file_size: formatFileSize(file.lfs?.size ?? file.size),
      sha256: file.lfs?.sha256,
    }
  })

  return {
    model_name: repo.modelId,
    revision: repo.sha,
    developer: repo.author,
    downloads: repo.downloads || 0,
    likes: repo.likes || 0,
    created_at: repo.createdAt,
    last_modified: repo.last_modified,
    num_quants: quants.length,
    quants: quants,
    num_mmproj: mmprojModels.length,
    mmproj_models: mmprojModels,
    safetensors_files: safetensorsModels,
    num_safetensors: safetensorsModels.length,
    is_mlx: hasMlxFiles,
    readme: `https://huggingface.co/${repo.modelId}/resolve/main/README.md`,
    description: `**Tags**: ${repo.tags?.join(', ')}`,
  }
}

function managedChatModel(
  entry: AtomicModelCatalog['models'][string]
): CatalogModel {
  const definition = entry.definition
  const repo = definition.model_name as string
  const model = hfRepoToCatalogModel({
    ...entry.metadata,
    id: repo,
    modelId: repo,
    sha: definition.revision,
    author: entry.metadata?.author ?? repo.split('/')[0],
    tags: entry.metadata?.tags ?? [],
    siblings: entry.files?.map((file) => ({
      rfilename: file.path,
      size: file.size,
      ...(file.sha256 ? { lfs: { size: file.size, sha256: file.sha256 } } : {}),
    })),
  } as HuggingFaceRepo)
  // Keep external quant IDs from the previously bundled discovery catalog.
  for (const quant of [
    ...(model.quants ?? []),
    ...(model.mmproj_models ?? []),
    ...(model.safetensors_files ?? []),
  ]) {
    const path = decodeURIComponent(
      quant.path.split('/resolve/')[1]?.split('/').slice(1).join('/') ?? ''
    )
    const original = entry.files?.find((file) => file.path === path)?.model_id
    if (original) quant.model_id = original
  }
  return model
}

export function unifiedChatModels(catalog: AtomicModelCatalog): CatalogModel[] {
  return Object.values(catalog.models)
    .filter((entry) => entry.kind === 'chat')
    .map(managedChatModel)
}

/** Managed cards use their explicit pin without narrowing the independent discovery catalog. */
export function pinnedRecommendationModel(
  sources: readonly CatalogModel[],
  repo: string,
  revision?: string
): CatalogModel | undefined {
  if (revision) {
    const entry = Object.values(atomicModelCatalogSnapshot().models).find(
      (entry) =>
        entry.kind === 'chat' &&
        String(entry.definition.model_name).toLowerCase() ===
          repo.toLowerCase() &&
        entry.definition.revision === revision
    )
    if (entry) return managedChatModel(entry)
  }
  return findCatalogModelForRecommendedRepo(sources, repo, revision)
}
