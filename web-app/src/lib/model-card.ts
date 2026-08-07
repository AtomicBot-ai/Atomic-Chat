import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import { getTotalDownloadFileSize } from '@/lib/models'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import type { StaffPickCategory } from '@/services/staff-picks-registry'

/**
 * Helpers for the Hub model card (v12). Hugging Face has no "capabilities"
 * field, so badges come from the curated staff-picks manifest where there is
 * one and from pipeline/tags signals on the catalog entry otherwise. Hardware
 * fit is estimated from the quant size vs the user's memory budget (HF computes
 * the same thing client-side).
 */

export type HardwareFit = 'ok' | 'maybe' | 'no'

/** Card summary label + hover tooltip, wording taken from Hugging Face. */
export const HARDWARE_FIT: Record<
  HardwareFit,
  { label: string; tip: string }
> = {
  ok: {
    label: 'Good fit',
    tip: 'This model is likely to run on your hardware',
  },
  maybe: {
    label: 'Should run',
    tip: 'This model can probably run on your hardware',
  },
  no: {
    label: 'Too large',
    tip: 'This model is probably too large for your hardware',
  },
}

/**
 * Outlined-tinted pill palette for the fit badge, in the same canon as the
 * capability badges: a light pill in light theme, a muted dark one with light
 * text in dark theme, so the badge survives both without losing its colour.
 */
export const FIT_BADGE_CLASS: Record<HardwareFit, string> = {
  ok: 'border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  maybe:
    'border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-200',
  no: 'border border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/45 dark:text-red-200',
}

const SIZE_UNIT_BYTES: Record<string, number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
}

/** Parse catalog file-size strings like "5.3 GB" / "412 MB" into bytes. */
export function parseFileSizeToBytes(fileSize?: string): number | undefined {
  if (!fileSize) return undefined
  const match = fileSize.trim().match(/^([\d.]+)\s*(KB|MB|GB|TB)$/i)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return value * SIZE_UNIT_BYTES[match[2].toUpperCase()]
}

/**
 * Representative quant for "how large is this model": the median of the
 * variants whose size is known.
 *
 * The smallest quant is a poor stand-in — a repo's IQ1/IQ2 rounding is a
 * curiosity almost nobody runs, so quoting it understates the row's size and
 * lets the device filter promise a fit the user will not get from the quant
 * they actually pick. Quants with no declared size are ignored rather than
 * treated as zero; if none carry a size we keep catalog order.
 */
export function pickMedianQuant(
  quants?: readonly ModelQuant[]
): ModelQuant | undefined {
  if (!quants?.length) return undefined

  const sized = quants
    .map((quant) => ({ quant, bytes: parseFileSizeToBytes(quant.file_size) }))
    .filter(
      (entry): entry is { quant: ModelQuant; bytes: number } =>
        entry.bytes !== undefined
    )
    .sort((left, right) => left.bytes - right.bytes)

  if (!sized.length) return quants[0]
  // Lower median on an even count: between two equally central quants, quote
  // the one more likely to run.
  return sized[Math.floor((sized.length - 1) / 2)].quant
}

/** Full download count with thin-space grouping, e.g. 1163988 -> "1 163 988". */
export function formatDownloads(n?: number): string {
  if (!n || n <= 0) return '0'
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')
}

/** Best-effort parameter count from the model name, e.g. "...-80B..." -> "80B". */
export function deriveParams(model: CatalogModel): string | undefined {
  const match = model.model_name.match(/(\d+(?:\.\d+)?)\s*[xX]?\s*B\b/)
  return match ? `${match[1]}B` : undefined
}

/** Best-effort context window from the model name, e.g. "256K" / "1M". */
export function deriveContext(model: CatalogModel): string | undefined {
  const match = model.model_name.match(/\b(\d+(?:\.\d+)?)\s*([KM])\b/)
  if (!match) return undefined
  return `${match[1]}${match[2].toUpperCase()}`
}

/** Format a raw parameter count (e.g. 7615616512) into "7.6B" / "671B" / "350M". */
export function formatParamCount(total?: number): string | undefined {
  if (!total || total <= 0) return undefined
  if (total >= 1e9) {
    const b = total / 1e9
    return `${b >= 100 ? Math.round(b) : Number(b.toFixed(1))}B`
  }
  if (total >= 1e6) return `${Math.round(total / 1e6)}M`
  return undefined
}

/** Format a context length in tokens (e.g. 262144) into "256K" / "1M". */
export function formatContextLength(tokens?: number): string | undefined {
  if (!tokens || tokens <= 0) return undefined
  const k = tokens / 1024
  if (k >= 1000) return `${Number((k / 1024).toFixed(1)).toString().replace(/\.0$/, '')}M`
  return `${Math.round(k)}K`
}

export type ModelStats = { params?: string; context?: string }

const modelStatsCache = new Map<string, ModelStats>()

/**
 * Fetch real params/context from the Hugging Face model API:
 *   params  ← safetensors.total | gguf.total
 *   context ← gguf.context_length | config.max_position_embeddings
 * Falls back to the repo config.json for context when the API omits it
 * (typical for safetensors/MLX repos). Cached per model id.
 */
export async function fetchModelStats(modelId: string): Promise<ModelStats> {
  if (modelStatsCache.has(modelId)) return modelStatsCache.get(modelId) as ModelStats
  const stats: ModelStats = {}
  try {
    const res = await fetch(`https://huggingface.co/api/models/${modelId}`)
    if (res.ok) {
      const d = await res.json()
      const total: number | undefined = d?.safetensors?.total ?? d?.gguf?.total
      stats.params = formatParamCount(total)
      const ctx: number | undefined =
        d?.gguf?.context_length ??
        d?.config?.max_position_embeddings ??
        d?.config?.text_config?.max_position_embeddings
      stats.context = formatContextLength(ctx)
    }
  } catch {
    // ignore — try config.json below / fall back to name heuristics
  }

  if (!stats.context) {
    try {
      const cfgRes = await fetch(
        `https://huggingface.co/${modelId}/resolve/main/config.json`
      )
      if (cfgRes.ok) {
        const cfg = await cfgRes.json()
        const ctx: number | undefined =
          cfg?.max_position_embeddings ??
          cfg?.text_config?.max_position_embeddings
        stats.context = formatContextLength(ctx)
      }
    } catch {
      // ignore
    }
  }

  modelStatsCache.set(modelId, stats)
  return stats
}

export type ModelFormat = 'mlx' | 'gguf'

export function modelFormat(model: CatalogModel): ModelFormat {
  if (model.is_mlx || model.library_name?.toLowerCase() === 'mlx') return 'mlx'
  return 'gguf'
}

export type Capability = {
  label: 'Vision' | 'Tool Use' | 'Reasoning' | 'Audio'
  className: string
}

//* Outlined-tinted палитра с light + dark вариантами — тот же канон, что у
//* FIT_BADGE_CLASS: светлый pill в light-теме и приглушённый тёмный с светлым
//* текстом в dark. Цвет каждой способности сохранён (amber/blue/fuchsia/teal).
const CAP_COLORS = {
  vision:
    'border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-200',
  tool: 'border border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200',
  reasoning:
    'border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950/45 dark:text-fuchsia-200',
  audio:
    'border border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-800 dark:bg-teal-950/45 dark:text-teal-200',
} as const

/** Manifest category -> badge, in the order the badges are rendered. */
const CURATED_CAPABILITIES: ReadonlyArray<{
  category: StaffPickCategory
  label: Capability['label']
  className: string
}> = [
  { category: 'vision', label: 'Vision', className: CAP_COLORS.vision },
  { category: 'tools', label: 'Tool Use', className: CAP_COLORS.tool },
  {
    category: 'reasoning',
    label: 'Reasoning',
    className: CAP_COLORS.reasoning,
  },
  { category: 'audio', label: 'Audio', className: CAP_COLORS.audio },
]

/**
 * Canonical capability badges (no synonyms).
 *
 * Two sources, in priority order:
 *
 *  1. `curated` — the `categories` of a staff-picks entry. A recommended model
 *     is hand-checked against its own model card, so its declaration wins
 *     outright, including when it declares no capability at all: an entry
 *     listing only `general` means "we looked, there is nothing to badge".
 *  2. Otherwise the catalog signals: mmproj presence, the `tools` flag, plus
 *     keyword hints in the name/description/library for reasoning and audio.
 *     Search results have no curated metadata, so they stay best-effort.
 *
 * `curated` being absent (not empty) is what selects the heuristic, so a pick
 * published without `categories` still gets badges.
 */
export function deriveCapabilities(
  model: CatalogModel,
  curated?: readonly StaffPickCategory[]
): Capability[] {
  if (curated) {
    return CURATED_CAPABILITIES.filter((entry) =>
      curated.includes(entry.category)
    ).map(({ label, className }) => ({ label, className }))
  }

  const hay =
    `${model.model_name} ${model.description ?? ''} ${model.library_name ?? ''}`.toLowerCase()
  const caps: Capability[] = []

  if ((model.num_mmproj ?? 0) > 0 || /image-text-to-text|vision|multimodal|-vl\b/.test(hay)) {
    caps.push({ label: 'Vision', className: CAP_COLORS.vision })
  }
  if (model.tools || /function[- ]?calling|tool[- ]?use|\btools\b/.test(hay)) {
    caps.push({ label: 'Tool Use', className: CAP_COLORS.tool })
  }
  if (/reasoning|thinking|chain[- ]of[- ]thought|\br1\b/.test(hay)) {
    caps.push({ label: 'Reasoning', className: CAP_COLORS.reasoning })
  }
  if (/audio-text-to-text|\baudio\b|speech/.test(hay)) {
    caps.push({ label: 'Audio', className: CAP_COLORS.audio })
  }
  return caps
}

/**
 * Quantization label shown as the mono "quant badge" in a variant row.
 *
 * `ModelQuant.model_id` is the full HF repo id for GGUF
 * (e.g. `mradermacher/Solon_Athens_v2_i1-IQ1_M`) but already a short token for
 * MLX (e.g. `4bit`). We surface only the quant scheme — the precision the file
 * was quantized to — never the whole repo path:
 *   GGUF:  IQ1_M, IQ2_XXS, Q4_K_M, Q6_K, Q8_0, F16 …
 *   MLX:   4BIT, 6BIT, 8BIT
 */
export function quantLabel(modelId: string): string {
  const seg = modelId.split('/').pop() ?? modelId
  // MLX: trailing "<n>bit"
  const bit = seg.match(/(\d+)\s*bit$/i)
  if (bit) return `${bit[1]}BIT`
  // GGUF: trailing quant token after a separator (I-quants, ternary TQ, plain Q)
  const gguf = seg.match(/[-_.]((?:[IT]?Q\d[0-9A-Za-z_]*)|BF16|F16|F32)$/i)
  if (gguf) return gguf[1].toUpperCase()
  // Fallback: last separator-delimited segment
  return (seg.split(/[-_.]/).pop() ?? seg).toUpperCase()
}

/**
 * Usable memory budget in bytes. `total_memory` and GPU `total_memory` are
 * reported in MB (see `formatMegaBytes`). We take the larger of system RAM and
 * total VRAM to avoid double-counting Apple unified memory.
 */
export function getMemoryBudgetBytes(hw: {
  total_memory?: number
  gpus?: Array<{ total_memory?: number }>
}): number {
  const ramMB = hw.total_memory ?? 0
  const gpuMB = (hw.gpus ?? []).reduce((sum, g) => sum + (g.total_memory ?? 0), 0)
  return Math.max(ramMB, gpuMB) * SIZE_UNIT_BYTES.MB
}

/**
 * 3-level hardware fit, matching Hugging Face's traffic-light model. Unknown
 * size/budget is treated as "maybe" rather than blocking the user.
 */
export function estimateFit(
  sizeBytes?: number,
  budgetBytes?: number
): HardwareFit {
  if (!budgetBytes || !sizeBytes) return 'maybe'
  if (sizeBytes <= budgetBytes * 0.7) return 'ok'
  if (sizeBytes <= budgetBytes) return 'maybe'
  return 'no'
}

/**
 * Quant the download panel opens on.
 *
 * The house default (`iq4_xs` / `q4_k_m`) wins whenever the repo ships it. Repos
 * that ship neither used to fall back to catalog order, which is how a card for
 * a 27B model opened on its F16 dump and greeted the user with "Too large"; the
 * median quant is the same variant the list row quotes, so the two agree.
 *
 * Either way the pick is checked against the memory budget: a preselection the
 * device cannot run is worthless, so we step down to the largest variant that
 * does fit. When nothing fits we offer the smallest one and let the badge say so.
 */
export function pickDownloadQuant(
  model: CatalogModel,
  budgetBytes = 0
): ModelQuant | undefined {
  const quants = model.quants
  if (!quants?.length) return undefined

  const preferred = quants.find((quant) =>
    DEFAULT_MODEL_QUANTIZATIONS.some((scheme) =>
      quant.model_id.toLowerCase().includes(scheme)
    )
  )
  const candidate = preferred ?? pickMedianQuant(quants)
  if (!candidate || !budgetBytes) return candidate

  const bytesOf = (quant: ModelQuant) =>
    parseFileSizeToBytes(getTotalDownloadFileSize(model, quant))
  if (estimateFit(bytesOf(candidate), budgetBytes) !== 'no') return candidate

  const sized = quants
    .map((quant) => ({ quant, bytes: bytesOf(quant) }))
    .filter(
      (entry): entry is { quant: ModelQuant; bytes: number } =>
        entry.bytes !== undefined
    )
    .sort((left, right) => left.bytes - right.bytes)

  const fitting = sized.filter((entry) => entry.bytes <= budgetBytes)
  return (fitting.at(-1) ?? sized[0])?.quant ?? candidate
}
