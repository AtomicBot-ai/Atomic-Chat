/**
 * The Model Hub's cheap narrowing of the Hugging Face feed under a managed engine's format (change
 * `add-tensorrt-llm-model-hub`, design D4; per engine, change `add-vllm-runtime`): from the listing
 * alone, leave out what certainly cannot run here — an architecture the engine's descriptor does
 * not support, or weights that with the engine's own overhead are larger than every card.
 * It is not a verdict: the quantization format is never looked at, and the card asks the core.
 */

import { isManagedProvider } from '@/lib/managed-engines'
import type { ModelFormat } from '@/lib/model-card'
import type { GpuFacts } from '@/services/managed-environment/types'
import type { CatalogModel, HuggingFaceFeedFormat } from '@/services/models/types'

/**
 * Bytes per parameter by safetensors dtype, as Hugging Face's listing counts parameters. `U8` of
 * NVFP4 is already the packed bytes. `I32`/`U32` are the containers AWQ, GPTQ and
 * compressed-tensors pack 4- and 8-bit weights into, and the listing reports them as logical
 * parameters (Qwen2.5-7B-Instruct-AWQ: `I32` 6.5e9, 5.6 GB on disk), so they count at the
 * narrowest packing, half a byte; a real 32-bit tensor is rare and small.
 */
const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 0.5,
  U32: 0.5,
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
 * What each engine holds beyond the weights on any card, the low end the core's check counts too:
 * `trtllm-serve` its CUDA context and cuBLAS workspaces (core 0.9.3,
 * `TENSORRT_LLM_RUNTIME_OVERHEAD_BYTES`), `vllm serve` its engine overhead (core
 * `VLLM_ENGINE_OVERHEAD_BYTES`). The activation peak and the KV-cache are left out: they need what
 * the listing does not carry, and the estimate may only ever be low. An engine not listed counts
 * none.
 */
export const ENGINE_OVERHEAD_BYTES: Readonly<Record<string, number>> = {
  'tensorrt-llm': 1.5 * 1024 ** 3,
  'vllm': 2 * 1024 ** 3,
}

export interface ManagedPrefilterContext {
  /** The engine whose format the Hub shows: its overhead counts. */
  engineId: string
  /** The descriptor's `supported_architectures`; null when it could not be read. */
  supportedArchitectures: readonly string[] | null
  /** The cards of this machine, from the core's environment snapshot. */
  gpus: readonly GpuFacts[]
}

export function passesManagedPrefilter(model: CatalogModel, context: ManagedPrefilterContext): boolean {
  const architectures = model.managed?.architectures ?? []
  // Without `config.json` there is nothing the engine could load.
  if (architectures.length === 0) return false
  const { supportedArchitectures, gpus } = context
  if (supportedArchitectures && !architectures.some((name) => supportedArchitectures.includes(name))) {
    return false
  }
  const weights = estimateWeightBytes(model.managed?.parameters)
  // A card with shared memory reports no VRAM, and the host's memory is not in the snapshot: the
  // size is left to the core's check rather than guessed against.
  if (weights === null || gpus.length === 0 || gpus.some((gpu) => gpu.total_vram_bytes === null)) {
    return true
  }
  const largest = Math.max(...gpus.map((gpu) => gpu.total_vram_bytes as number))
  return weights + (ENGINE_OVERHEAD_BYTES[context.engineId] ?? 0) <= largest
}

/** Where the Hub's list comes from under each format (design D3, D4). */
export interface HubListSources {
  /** The curated picks of `atomic-chat-conf` (GGUF and MLX entries only). */
  staffPicks: boolean
  /** The app's model catalog, searched locally. */
  catalog: boolean
  /** The engine's curated models: a managed engine descriptor's, or PrismML's Bonsai families. */
  curated: boolean
  feedFormat: HuggingFaceFeedFormat
  /** Narrow feed and search rows with `passesManagedPrefilter`. */
  prefilter: boolean
}

export function hubListSources(format: ModelFormat): HubListSources {
  // Every managed engine lists the same safetensors feed, narrowed by its own descriptor.
  if (isManagedProvider(format)) {
    return { staffPicks: false, catalog: false, curated: true, feedFormat: 'safetensors', prefilter: true }
  }
  // PrismML lists the Bonsai families of the core's model rules, and nothing else.
  if (format === 'atomic-prism') {
    return { staffPicks: false, catalog: false, curated: true, feedFormat: 'gguf', prefilter: false }
  }
  return {
    staffPicks: true,
    catalog: true,
    curated: false,
    feedFormat: format === 'mlx' ? 'mlx' : 'gguf',
    prefilter: false,
  }
}

export interface ManagedRow {
  model: CatalogModel
  /** `exact`: typed in full as `owner/repo`, shown whatever the prefilter says. */
  section: 'curated' | 'feed' | 'exact'
}

const repoKey = (model: CatalogModel) => model.model_name.toLowerCase()

function narrowed(
  rows: ManagedRow[],
  models: readonly CatalogModel[],
  context: ManagedPrefilterContext
): ManagedRow[] {
  const taken = new Set(rows.map((row) => repoKey(row.model)))
  for (const model of models) {
    const key = repoKey(model)
    if (taken.has(key)) continue
    taken.add(key)
    if (passesManagedPrefilter(model, context)) rows.push({ model, section: 'feed' })
  }
  return rows
}

/** Browsing: the curated models first, then the Hugging Face feed, narrowed, without repeats. */
export function managedBrowseRows(options: {
  curated: readonly CatalogModel[]
  feed: readonly CatalogModel[]
  context: ManagedPrefilterContext
}): ManagedRow[] {
  const rows = options.curated.map((model): ManagedRow => ({ model, section: 'curated' }))
  return narrowed(rows, options.feed, options.context)
}

/** Searching: a repository typed exactly first and as it is, then the narrowed hits. */
export function managedSearchRows(options: {
  exact: CatalogModel | null
  candidates: readonly CatalogModel[]
  context: ManagedPrefilterContext
}): ManagedRow[] {
  const rows: ManagedRow[] = options.exact ? [{ model: options.exact, section: 'exact' }] : []
  return narrowed(rows, options.candidates, options.context)
}
