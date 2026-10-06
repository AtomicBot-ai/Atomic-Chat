/**
 * The Model Hub's cheap narrowing of the Hugging Face feed under the TensorRT-LLM format (change
 * `add-tensorrt-llm-model-hub`, design D4): from the listing alone, leave out what certainly cannot
 * run here — an architecture the descriptor does not support, or weights that with the engine's own
 * overhead are larger than every card.
 * It is not a verdict: the quantization format is never looked at, and the card asks the core.
 */

import type { ModelFormat } from '@/lib/model-card'
import type { GpuFacts } from '@/services/managed-environment/types'
import type { CatalogModel, HuggingFaceFeedFormat } from '@/services/models/types'

/** Bytes per element by safetensors dtype; `U8` of NVFP4 is already the packed bytes. */
const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 4,
  U32: 4,
  BF16: 2,
  F16: 2,
  I16: 2,
  U16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
}

/**
 * A dtype not listed here (a newer packed format) counts at one byte: the estimate may only ever
 * be low, never hide a model that would fit.
 */
const bytesOf = (dtype: string) => (dtype.startsWith('F8_') ? 1 : (DTYPE_BYTES[dtype] ?? 1))

/** Σ parameters × bytes per dtype, or null when the listing carries no parameters. */
export function estimateWeightBytes(parameters: Record<string, number> | undefined): number | null {
  const entries = Object.entries(parameters ?? {})
  if (entries.length === 0) return null
  return entries.reduce((total, [dtype, count]) => total + count * bytesOf(dtype), 0)
}

/**
 * What `trtllm-serve` holds beyond the weights on any card (CUDA context, cuBLAS workspaces): the
 * low end the core's check counts too (core 0.9.3, `TENSORRT_LLM_RUNTIME_OVERHEAD_BYTES`). The
 * activation peak is left out: it needs `intermediate_size`, which the listing does not carry, and
 * the estimate may only ever be low.
 */
export const TENSORRT_ENGINE_OVERHEAD_BYTES = 1.5 * 1024 ** 3

export interface TensorrtPrefilterContext {
  /** The descriptor's `supported_architectures`; null when it could not be read. */
  supportedArchitectures: readonly string[] | null
  /** The cards of this machine, from the core's environment snapshot. */
  gpus: readonly GpuFacts[]
}

export function passesTensorrtPrefilter(model: CatalogModel, context: TensorrtPrefilterContext): boolean {
  const architectures = model.tensorrt?.architectures ?? []
  // Without `config.json` there is nothing the engine could load.
  if (architectures.length === 0) return false
  const { supportedArchitectures, gpus } = context
  if (supportedArchitectures && !architectures.some((name) => supportedArchitectures.includes(name))) {
    return false
  }
  const weights = estimateWeightBytes(model.tensorrt?.parameters)
  // A card with shared memory reports no VRAM, and the host's memory is not in the snapshot: the
  // size is left to the core's check rather than guessed against.
  if (weights === null || gpus.length === 0 || gpus.some((gpu) => gpu.total_vram_bytes === null)) {
    return true
  }
  const largest = Math.max(...gpus.map((gpu) => gpu.total_vram_bytes as number))
  return weights + TENSORRT_ENGINE_OVERHEAD_BYTES <= largest
}

/** Where the Hub's list comes from under each format (design D3, D4). */
export interface HubListSources {
  /** The curated picks of `atomic-chat-conf` (GGUF and MLX entries only). */
  staffPicks: boolean
  /** The app's model catalog, searched locally. */
  catalog: boolean
  /** The TensorRT-LLM descriptor's curated models, checked by the core. */
  curated: boolean
  feedFormat: HuggingFaceFeedFormat
  /** Narrow feed and search rows with `passesTensorrtPrefilter`. */
  prefilter: boolean
}

export function hubListSources(format: ModelFormat): HubListSources {
  if (format === 'tensorrt-llm') {
    return { staffPicks: false, catalog: false, curated: true, feedFormat: 'tensorrt-llm', prefilter: true }
  }
  return { staffPicks: true, catalog: true, curated: false, feedFormat: format, prefilter: false }
}

export interface TensorrtRow {
  model: CatalogModel
  /** `exact`: typed in full as `owner/repo`, shown whatever the prefilter says. */
  section: 'curated' | 'feed' | 'exact'
}

const repoKey = (model: CatalogModel) => model.model_name.toLowerCase()

function narrowed(
  rows: TensorrtRow[],
  models: readonly CatalogModel[],
  context: TensorrtPrefilterContext
): TensorrtRow[] {
  const taken = new Set(rows.map((row) => repoKey(row.model)))
  for (const model of models) {
    const key = repoKey(model)
    if (taken.has(key)) continue
    taken.add(key)
    if (passesTensorrtPrefilter(model, context)) rows.push({ model, section: 'feed' })
  }
  return rows
}

/** Browsing: the curated models first, then the Hugging Face feed, narrowed, without repeats. */
export function tensorrtBrowseRows(options: {
  curated: readonly CatalogModel[]
  feed: readonly CatalogModel[]
  context: TensorrtPrefilterContext
}): TensorrtRow[] {
  const rows = options.curated.map((model): TensorrtRow => ({ model, section: 'curated' }))
  return narrowed(rows, options.feed, options.context)
}

/** Searching: a repository typed exactly first and as it is, then the narrowed hits. */
export function tensorrtSearchRows(options: {
  exact: CatalogModel | null
  candidates: readonly CatalogModel[]
  context: TensorrtPrefilterContext
}): TensorrtRow[] {
  const rows: TensorrtRow[] = options.exact ? [{ model: options.exact, section: 'exact' }] : []
  return narrowed(rows, options.candidates, options.context)
}
