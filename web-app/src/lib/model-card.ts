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
    tip: 'Full offload likely possible on your system.',
  },
  maybe: {
    label: 'Might fit',
    tip: 'Within the last GB of VRAM headroom, so loading can fail if other apps are using GPU memory.',
  },
  no: {
    label: 'Won’t fit',
    tip: 'Exceeds combined VRAM and system RAM budget.',
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

/** The BCP 47 tag `Intl` reads for an app language: `vn` is the app's own tag for Vietnamese. */
export function intlLocale(language?: string): string {
  if (!language) return 'en'
  return language === 'vn' ? 'vi' : language
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How long ago a date was, in the interface language: "3 days ago", "vor 3 Tagen",
 * "3 дня назад". `Intl.RelativeTimeFormat` carries each language's plural forms and
 * word order, which a hand-built "N days ago" got wrong ("1 days ago") and never
 * translated.
 *
 * Minutes under an hour, hours under a day, then days, weeks under a month, 30-day
 * months under a year, and years. `undefined` for a missing or unreadable date.
 */
export function formatTimeAgo(
  date: string | undefined,
  language: string | undefined,
  now: number = Date.now()
): string | undefined {
  if (!date) return undefined
  const parsed = Date.parse(date)
  if (!Number.isFinite(parsed)) return undefined
  const elapsed = Math.max(0, now - parsed)
  const days = Math.floor(elapsed / DAY_MS)
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    elapsed < HOUR_MS
      ? [Math.max(1, Math.floor(elapsed / MINUTE_MS)), 'minute']
      : elapsed < DAY_MS
        ? [Math.floor(elapsed / HOUR_MS), 'hour']
        : days < 7
          ? [days, 'day']
          : days < 30
            ? [Math.floor(days / 7), 'week']
            : days < 365
              ? [Math.floor(days / 30), 'month']
              : [Math.floor(days / 365), 'year']
  let format: Intl.RelativeTimeFormat
  try {
    format = new Intl.RelativeTimeFormat(intlLocale(language), {
      numeric: 'always',
    })
  } catch {
    // A malformed language tag reads as English rather than failing the row.
    format = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
  }
  return format.format(-value, unit)
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

const modelParamsCache = new Map<string, string | undefined>()

/**
 * The parameter count Hugging Face's model API reports for a repo
 * (`safetensors.total`, else `gguf.total`), as "9B"; `undefined` when it
 * reports none. Cached per repo, a "none" too; a request that failed is asked
 * again next time.
 */
export async function fetchModelParams(
  modelId: string
): Promise<string | undefined> {
  if (modelParamsCache.has(modelId)) return modelParamsCache.get(modelId)
  const res = await fetch(`https://huggingface.co/api/models/${modelId}`)
  let params: string | undefined
  if (res.ok) {
    const d = await res.json()
    params = formatParamCount(d?.safetensors?.total ?? d?.gguf?.total)
  }
  modelParamsCache.set(modelId, params)
  return params
}

/**
 * A Hub format: a file format, or a managed engine (its provider id) for a safetensors checkpoint.
 * `atomic-prism` is a list rather than a file format: the Bonsai GGUF files only PrismML's
 * llama.cpp runs, which `modelFormat` reads as GGUF.
 */
export type ModelFormat =
  | 'mlx'
  | 'gguf'
  | 'vllm'
  | 'sglang'
  | 'tensorrt-llm'
  | 'atomic-prism'
  | 'foundry-local'

/**
 * The format a card is shown under. A managed engine's checkpoint is one for every managed engine
 * (change `add-vllm-runtime`): it reads as the managed format the Hub is showing, `managedFormat`.
 */
export function modelFormat(
  model: CatalogModel,
  managedFormat: ModelFormat = 'tensorrt-llm'
): ModelFormat {
  if (model.is_foundry_local) return 'foundry-local'
  if (model.is_managed) return managedFormat
  if (model.is_mlx || model.library_name?.toLowerCase() === 'mlx') return 'mlx'
  return 'gguf'
}

export type Capability = {
  label: 'Vision' | 'Tool Use' | 'Reasoning' | 'Audio'
  className: string
}

//* Outlined-tinted palette with light + dark variants — the same convention as
//* FIT_BADGE_CLASS: a light pill in the light theme and a muted dark one with light
//* text in dark. Each capability keeps its color (amber/blue/fuchsia/teal).
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

  if (
    (model.num_mmproj ?? 0) > 0 ||
    /image-text-to-text|vision|multimodal|-vl\b/.test(hay)
  ) {
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
  // GGUF: trailing quant token after a separator (I-quants, ternary TQ,
  // PrismML's PQ / PTQ packings, plain Q)
  const gguf = seg.match(
    /[-_.]((?:(?:[IT]|PT?)?Q\d[0-9A-Za-z_]*)|BF16|F16|F32)$/i
  )
  if (gguf) return gguf[1].toUpperCase()
  // Fallback: last separator-delimited segment
  return (seg.split(/[-_.]/).pop() ?? seg).toUpperCase()
}

/**
 * The manifest entry that pins a quant names it as a plain token (`Q8_0`).
 * Match it against the token {@link quantLabel} parses out of the file id,
 * rather than a substring test — `includes('q4_0')` would also hit `Q4_0_4_4`,
 * and `includes('q8_0')` would hit a projector when scanning weights.
 *
 * `sanitizeModelId` rewrites `.` to `_`, so a pin written `Q4.K.M` still
 * matches. Returns `undefined` when nothing matches, so callers fall back to
 * their normal selection instead of failing the download.
 */
export function findPinnedQuant<T extends { model_id: string }>(
  candidates: readonly T[] | undefined,
  pin?: string
): T | undefined {
  if (!candidates?.length || !pin) return undefined
  const wanted = pin.toUpperCase().replace(/\./g, '_')
  return candidates.find((c) => quantLabel(c.model_id) === wanted)
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
  const gpuMB = (hw.gpus ?? []).reduce(
    (sum, g) => sum + (g.total_memory ?? 0),
    0
  )
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
 * The quant a repo is quoted by before this device has a say: the house default
 * (`iq4_xs` / `q4_k_m`) whenever the repo ships it, else the median quant.
 *
 * It is where the download panel starts ({@link pickDownloadQuant}), so a list row
 * that quotes it names the size the panel opens on. Quoting the median there while
 * the panel opened on the house default is how bartowski's SmolLM2-135M read
 * 93.0 MB (Q3_K_L, the median of 23 quants) in the row and 86.7 MB (IQ4_XS) in the
 * panel, and AtomicChat's Qwen3.5-9B 6.0 GB (Q5_K_M) against 5.2 GB (Q4_K_M).
 */
export function pickListedQuant(
  model: Pick<CatalogModel, 'quants'>
): ModelQuant | undefined {
  const quants = model.quants
  if (!quants?.length) return undefined
  const preferred = quants.find((quant) =>
    DEFAULT_MODEL_QUANTIZATIONS.some((scheme) =>
      quant.model_id.toLowerCase().includes(scheme)
    )
  )
  return preferred ?? pickMedianQuant(quants)
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

  const candidate = pickListedQuant(model)
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
