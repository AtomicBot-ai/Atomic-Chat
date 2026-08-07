import { providerModels as models } from '@/constants/models'
import type {
  CatalogModel,
  MMProjModel,
  ModelQuant,
} from '@/services/models/types'
import { ModelCapabilities } from '@/types/models'

export const defaultModel = (provider?: string) => {
  if (!provider || !Object.keys(models).includes(provider)) {
    return models.openai.models[0]
  }
  return (
    models[provider as unknown as keyof typeof models]
      .models as unknown as string[]
  )[0]
}

/**
 * Determines model capabilities based on provider configuration from token.js
 * @param providerName - The provider name (e.g., 'openai', 'anthropic', 'openrouter')
 * @param modelId - The model ID to check capabilities for
 * @returns Array of model capabilities
 */
export const getModelCapabilities = (
  providerName: string,
  modelId: string
): string[] => {
  const providerConfig = models[providerName as unknown as keyof typeof models]

  const supportsToolCalls = Array.isArray(
    providerConfig?.supportsToolCalls as unknown
  )
    ? (providerConfig.supportsToolCalls as unknown as string[])
    : []

  const supportsImages = Array.isArray(
    providerConfig?.supportsImages as unknown
  )
    ? (providerConfig.supportsImages as unknown as string[])
    : []

  return [
    ModelCapabilities.COMPLETION,
    supportsToolCalls.includes(modelId) ? ModelCapabilities.TOOLS : undefined,
    supportsImages.includes(modelId) ? ModelCapabilities.VISION : undefined,
  ].filter(Boolean) as string[]
}

/**
 * This utility is to extract cortexso model description from README.md file
 * @returns
 */
export const extractDescription = (text?: string) => {
  if (!text) return text
  const normalizedText = removeYamlFrontMatter(text)
  const overviewPattern = /(?:##\s*Overview\s*\n)([\s\S]*?)(?=\n\s*##|$)/
  const matches = normalizedText?.match(overviewPattern)
  let extractedText =
    matches && matches[1]
      ? matches[1].trim()
      : normalizedText?.slice(0, 500).trim()

  // Remove image markdown syntax ![alt text](image-url)
  extractedText = extractedText?.replace(/!\[.*?\]\(.*?\)/g, '')

  // Remove <img> HTML tags
  extractedText = extractedText?.replace(/<img[^>]*>/g, '')

  return extractedText
}
/**
 * Remove YAML (HF metadata) front matter from content
 * @param content
 * @returns
 */
export const removeYamlFrontMatter = (content: string): string => {
  return content.replace(/^---\n([\s\S]*?)\n---\n/, '')
}

/**
 * Extract model name from repo path, e.g. cortexso/tinyllama -> tinyllama
 * @param modelId
 * @returns
 */
export const extractModelName = (model?: string) => {
  return model?.split('/')[1] ?? model
}

const FILE_SIZE_TO_BYTES: Record<'MB' | 'GB', number> = {
  MB: 1024 ** 2,
  GB: 1024 ** 3,
}

function parseCatalogFileSize(fileSize?: string): number | undefined {
  if (!fileSize) return undefined

  const match = fileSize.trim().match(/^([\d.]+)\s*(MB|GB)$/i)
  if (!match) return undefined

  const value = Number(match[1])
  const unit = match[2].toUpperCase() as keyof typeof FILE_SIZE_TO_BYTES
  if (!Number.isFinite(value)) return undefined

  return value * FILE_SIZE_TO_BYTES[unit]
}

function formatCatalogFileSize(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes)) return undefined

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// MTP (Multi-Token Prediction) companion GGUFs are speculative-decoding heads,
// not standalone models, so we keep them out of the downloadable quant list.
// Match only dedicated MTP files: an `MTP/` folder, or `mtp` as a leading/trailing
// filename token. `mtp` mid-name (e.g. Qwen built-in-MTP full models) is left intact.
export function isMtpCompanionFile(rfilename: string): boolean {
  const lower = rfilename.toLowerCase()
  if (/(^|\/)mtp\//.test(lower)) return true
  const base = (lower.split('/').pop() ?? lower).replace(/\.gguf$/, '')
  return /^mtp[-_.]/.test(base) || /[-_]mtp$/.test(base)
}

// A quant too large for one file is published as `-00001-of-000NN` shards, and
// the repo listing carries each shard as a file of its own. Taken at face value
// they enter the Hub as separate quants: the first shard is a few-megabyte
// header, so a 156 GB variant advertises itself as a 5 MB "Good fit" and its
// badge degrades to "00001". Everything a shard set shares -- id, size, quant
// label -- comes from the name with this suffix removed.
const GGUF_SHARD_SUFFIX = /-\d{5}-of-\d{5}(?=\.gguf$|$)/i

/** Name a shard set is known by: the filename without its `-NNNNN-of-NNNNN`. */
export function ggufShardGroupKey(rfilename: string): string {
  return rfilename.replace(GGUF_SHARD_SUFFIX, '')
}

/** Group files by the quant they belong to, preserving repository order. */
export function groupGgufShards<T extends { rfilename: string }>(
  files: readonly T[]
): T[][] {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const key = ggufShardGroupKey(file.rfilename)
    const group = groups.get(key)
    if (group) group.push(file)
    else groups.set(key, [file])
  }
  // Repositories list shards in order, but nothing guarantees it, and the first
  // shard is the one a download has to start from.
  return [...groups.values()].map((group) =>
    [...group].sort((left, right) =>
      left.rfilename.localeCompare(right.rfilename)
    )
  )
}

/**
 * Fold the shards of a quant back into the single variant they form.
 *
 * The curated catalog mirrors the repository file list, so a sharded quant
 * arrives as one entry per shard — the Hub would otherwise offer `unsloth`
 * MoE repos as dozens of `00001`-badged variants, most of them 5 MB headers.
 * The download keeps pointing at the first shard; only the quoted size changes,
 * to that of the whole set.
 */
export function mergeShardedQuants<
  T extends Pick<CatalogModel, 'quants' | 'num_quants'>,
>(model: T): T {
  if (!model.quants?.length) return model

  const groups = groupGgufShards(
    model.quants.map((quant) => ({
      rfilename: quant.path || quant.model_id,
      quant,
    }))
  )
  if (groups.length === model.quants.length) return model

  const quants = groups.map(([first, ...rest]) => {
    const totalBytes = [first, ...rest].reduce(
      (sum, entry) => sum + (parseCatalogFileSize(entry.quant.file_size) ?? 0),
      0
    )
    return {
      ...first.quant,
      model_id: ggufShardGroupKey(first.quant.model_id),
      file_size: formatCatalogFileSize(totalBytes) ?? first.quant.file_size,
    }
  })

  return { ...model, quants, num_quants: quants.length }
}

// Drop MTP companion quants from a catalog entry, keying off the file path
// (the real HF filename) and falling back to the quant id when absent.
export function stripMtpCompanionQuants<
  T extends Pick<CatalogModel, 'quants' | 'num_quants'>,
>(model: T): T {
  if (!model.quants?.length) return model
  const quants = model.quants.filter(
    (q) => !isMtpCompanionFile(q.path || q.model_id)
  )
  if (quants.length === model.quants.length) return model
  return { ...model, quants, num_quants: quants.length }
}

export function getPreferredMmprojModel(
  model: Pick<CatalogModel, 'mmproj_models'>
): MMProjModel | undefined {
  return (
    model.mmproj_models?.find(
      (mmproj) => mmproj.model_id.toLowerCase() === 'mmproj-f16'
    ) ?? model.mmproj_models?.[0]
  )
}

export function getTotalDownloadFileSize(
  model: Pick<CatalogModel, 'mmproj_models'>,
  variant?: Pick<ModelQuant, 'file_size'> | null
): string | undefined {
  const modelBytes = parseCatalogFileSize(variant?.file_size)
  const mmprojBytes = parseCatalogFileSize(
    getPreferredMmprojModel(model)?.file_size
  )

  if (modelBytes === undefined) {
    return variant?.file_size
  }

  return formatCatalogFileSize(modelBytes + (mmprojBytes ?? 0))
}

//* MLX: суммируем размер всех safetensors-шардов (HF часто режет на 00001-of-0000N)
export function getMlxTotalFileSize(
  model: Pick<CatalogModel, 'safetensors_files'>
): string | undefined {
  const files = model.safetensors_files
  if (!files || files.length === 0) return undefined

  let totalBytes = 0
  let parsedAny = false
  for (const file of files) {
    const bytes = parseCatalogFileSize(file.file_size)
    if (bytes !== undefined) {
      totalBytes += bytes
      parsedAny = true
    }
  }

  if (!parsedAny) {
    return files[0]?.file_size
  }

  return formatCatalogFileSize(totalBytes)
}

//* Hub / setup: рекомендованный repo id ↔ запись каталога.
//* Совпадение строго по полному `org/repo` (case-insensitive). Без fallback
//* по «хвосту» — иначе при коллизии (`unsloth/X` vs `lmstudio-community/X`)
//* recommended из одной орги молча резолвится в чужую модель.
export function findCatalogModelForRecommendedRepo(
  sources: readonly CatalogModel[],
  recommendedRepoId: string
): CatalogModel | undefined {
  if (!recommendedRepoId) return undefined
  const target = recommendedRepoId.toLowerCase()
  return sources.find((s) => s.model_name.toLowerCase() === target)
}

/**
 * Extract model name from repo path, e.g. https://huggingface.co/cortexso/tinyllama -> cortexso/tinyllama
 * @param modelId
 * @returns
 */
export const extractModelRepo = (model?: string) => {
  return model?.replace('https://huggingface.co/', '')
}
