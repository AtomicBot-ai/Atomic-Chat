// File path utilities
export function basenameNoExt(filePath: string): string {
  const VALID_EXTENSIONS = [".tar.gz", ".zip"];
  
  // handle VALID extensions first
  for (const ext of VALID_EXTENSIONS) {
    if (filePath.toLowerCase().endsWith(ext)) {
      return filePath.slice(0, -ext.length);
    }
  }
  
  // fallback: remove only the last extension
  const lastDotIndex = filePath.lastIndexOf('.');
  if (lastDotIndex > 0) {
    return filePath.slice(0, lastDotIndex);
  }
  
  return filePath;
}

// --- Backend mismatch classification ---

/**
 * Startup-log evidence of which device a loaded model actually runs on, as
 * returned by the Tauri plugin (`SessionInfo.runtime_device`).
 */
export interface RuntimeDeviceSnapshot {
  loaded_backends?: string[]
  primary_device?: string
  gpu_layers_offloaded?: number | null
  total_layers?: number | null
  gpu_buffer_bytes?: number | null
  cuda_runtime_missing?: boolean
  device_init_error?: string | null
}

/**
 * Ways the backend the user sees can disagree with the one actually doing the
 * work. All three are real and independent:
 *
 * - `silent-fallback`: the load path swapped the backend in memory without
 *   persisting it, so the settings dropdown still shows the old pick.
 * - `runtime-cpu`: the selected GPU build launched but the model landed on the
 *   CPU anyway (missing CUDA runtime, parked dGPU, driver/ABI mismatch).
 * - `suboptimal-config`: the backend runs as selected, but this host has a
 *   faster tier available.
 */
export type BackendMismatch =
  | { kind: 'ok' }
  | {
      kind: 'silent-fallback'
      configured: string
      effective: string
    }
  | {
      kind: 'runtime-cpu'
      configured: string
      primaryDevice: string
      offloaded: number | null
      total: number | null
      gpuKind: GpuKind
      cudaRuntimeMissing: boolean
      deviceInitError: string | null
    }
  | {
      kind: 'suboptimal-config'
      configured: string
      ideal: string
    }

const GPU_BACKEND_CATEGORIES = new Set([
  'cuda-cu13',
  'cuda-cu13.0',
  'cuda-cu12.4',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'rocm',
  'vulkan',
])

export function isGpuBackendCategory(category: string): boolean {
  return GPU_BACKEND_CATEGORIES.has(category)
}

/**
 * Which GPU stack a build targets. Each one needs different advice when the
 * build ends up on the CPU: install the NVIDIA CUDA runtime, install the AMD
 * ROCm runtime, or install/update the Vulkan driver.
 */
export type GpuKind = 'cuda' | 'rocm' | 'vulkan' | 'other'

export function gpuKindOf(category: string): GpuKind {
  if (category.startsWith('cuda-')) return 'cuda'
  if (category === 'rocm') return 'rocm'
  if (category === 'vulkan') return 'vulkan'
  return 'other'
}

function normalizeBackendId(backend: string | undefined | null): string {
  return (backend ?? '').replace(/\uFEFF/g, '').trim()
}

/**
 * True when the startup log shows the weights sitting in CPU buffers. Zero
 * offloaded layers is conclusive on its own; an absent/unparsed device is not
 * treated as CPU so a quieter build never triggers a false warning.
 */
export function runtimeRanOnCpu(
  runtimeDevice: RuntimeDeviceSnapshot | undefined | null
): boolean {
  if (!runtimeDevice) return false
  if (runtimeDevice.gpu_layers_offloaded === 0) return true
  const primary = (runtimeDevice.primary_device ?? '').trim()
  if (!primary) return false
  return primary === 'CPU' || primary.startsWith('CPU_')
}

/**
 * True when a GPU-tier load failed to initialise the GPU stack even if
 * `load_tensors` never printed an offload summary (empty primary / backends).
 * Covers "no usable GPU found", missing cudart, and the spawn-time
 * `cuda_runtime_missing` probe.
 */
export function runtimeGpuInitFailed(
  runtimeDevice: RuntimeDeviceSnapshot | undefined | null
): boolean {
  if (!runtimeDevice) return false
  if (runtimeDevice.cuda_runtime_missing === true) return true
  const err = (runtimeDevice.device_init_error ?? '').trim()
  return err.length > 0
}

/**
 * Compare what the UI shows, what was launched and what the process reports.
 * `categoryOf` is injected because the two providers use different backend id
 * schemes (`windows-x64-cuda-13.3` vs `win-cuda-13.3-x64`).
 *
 * Precedence: a silent swap first (the UI is outright wrong), then a GPU build
 * that degraded to CPU, then a merely better tier being available.
 *
 * `requestedGpuLayers` is the `-ngl` the load asked for. The "GPU Layers" model
 * setting documents 0 as "CPU only", so zero offloaded layers is then the
 * outcome the user asked for, not a degradation to report.
 */
export function classifyBackendMismatch(input: {
  configuredBackend: string | undefined | null
  effectiveBackend: string | undefined | null
  runtimeDevice?: RuntimeDeviceSnapshot | null
  idealBackend?: string | null
  requestedGpuLayers?: number | null
  categoryOf: (backend: string) => string
}): BackendMismatch {
  const configured = normalizeBackendId(input.configuredBackend)
  const effective = normalizeBackendId(input.effectiveBackend) || configured
  if (!configured) return { kind: 'ok' }

  if (effective && effective !== configured) {
    return { kind: 'silent-fallback', configured, effective }
  }

  const effectiveCategory = input.categoryOf(effective)
  const cpuOnlyByRequest = input.requestedGpuLayers === 0

  if (
    isGpuBackendCategory(effectiveCategory) &&
    !cpuOnlyByRequest &&
    (runtimeRanOnCpu(input.runtimeDevice) ||
      runtimeGpuInitFailed(input.runtimeDevice))
  ) {
    return {
      kind: 'runtime-cpu',
      configured: effective,
      primaryDevice: (input.runtimeDevice?.primary_device ?? '').trim() || 'CPU',
      offloaded: input.runtimeDevice?.gpu_layers_offloaded ?? null,
      total: input.runtimeDevice?.total_layers ?? null,
      gpuKind: gpuKindOf(effectiveCategory),
      cudaRuntimeMissing: input.runtimeDevice?.cuda_runtime_missing === true,
      deviceInitError: input.runtimeDevice?.device_init_error ?? null,
    }
  }

  const ideal = normalizeBackendId(input.idealBackend)
  if (ideal) {
    const idealCategory = input.categoryOf(ideal)
    // Only ever nudge upward: a user who deliberately picked CPU while the
    // detector also says CPU, or whose GPU tier is already ideal, is left alone.
    if (isGpuBackendCategory(idealCategory) && idealCategory !== effectiveCategory) {
      return { kind: 'suboptimal-config', configured: effective, ideal }
    }
  }

  return { kind: 'ok' }
}

// Zustand proxy state structure
interface ProxyState {
  proxyEnabled: boolean
  proxyUrl: string
  proxyUsername: string
  proxyPassword: string
  proxyIgnoreSSL: boolean
  verifyProxySSL: boolean
  verifyProxyHostSSL: boolean
  verifyPeerSSL: boolean
  verifyHostSSL: boolean
  noProxy: string
}

export function getProxyConfig(): Record<
  string,
  string | string[] | boolean
> | null {
  try {
    // Retrieve proxy configuration from localStorage
    const proxyConfigString = localStorage.getItem('setting-proxy-config')
    if (!proxyConfigString) {
      return null
    }

    const proxyConfigData = JSON.parse(proxyConfigString)

    const proxyState: ProxyState = proxyConfigData?.state

    // Only return proxy config if proxy is enabled
    if (!proxyState || !proxyState.proxyEnabled || !proxyState.proxyUrl) {
      return null
    }

    const proxyConfig: Record<string, string | string[] | boolean> = {
      url: proxyState.proxyUrl,
    }

    // Add username/password if both are provided
    if (proxyState.proxyUsername && proxyState.proxyPassword) {
      proxyConfig.username = proxyState.proxyUsername
      proxyConfig.password = proxyState.proxyPassword
    }

    // Parse no_proxy list if provided
    if (proxyState.noProxy) {
      const noProxyList = proxyState.noProxy
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)

      if (noProxyList.length > 0) {
        proxyConfig.no_proxy = noProxyList
      }
    }

    // Add SSL verification settings
    proxyConfig.ignore_ssl = proxyState.proxyIgnoreSSL
    proxyConfig.verify_proxy_ssl = proxyState.verifyProxySSL
    proxyConfig.verify_proxy_host_ssl = proxyState.verifyProxyHostSSL
    proxyConfig.verify_peer_ssl = proxyState.verifyPeerSSL
    proxyConfig.verify_host_ssl = proxyState.verifyHostSSL

    // Log proxy configuration for debugging
    console.log('Using proxy configuration:', {
      url: proxyState.proxyUrl,
      hasAuth: !!(proxyState.proxyUsername && proxyState.proxyPassword),
      noProxyCount: proxyConfig.no_proxy
        ? (proxyConfig.no_proxy as string[]).length
        : 0,
      ignoreSSL: proxyState.proxyIgnoreSSL,
      verifyProxySSL: proxyState.verifyProxySSL,
      verifyProxyHostSSL: proxyState.verifyProxyHostSSL,
      verifyPeerSSL: proxyState.verifyPeerSSL,
      verifyHostSSL: proxyState.verifyHostSSL,
    })

    return proxyConfig
  } catch (error) {
    console.error('Failed to parse proxy configuration:', error)
    if (error instanceof SyntaxError) {
      // JSON parsing error - return null
      return null
    }
    // Other errors (like missing state) - throw
    throw error
  }
}

// --- Embedding batching helpers ---

export type EmbedBatch = { batch: string[]; offset: number }
export type EmbedUsage = { prompt_tokens?: number; total_tokens?: number }
export type EmbedData = { embedding: number[]; index: number }

export type EmbedBatchResult = {
  data: EmbedData[]
  usage?: EmbedUsage
}

// Embedding batching constants
const DEFAULT_CHARS_PER_TOKEN = 3
const UBATCH_SAFETY_MARGIN = 0.5

export function estimateTokensFromText(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.max(1, Math.ceil(text.length / Math.max(charsPerToken, 1)))
}

export function buildEmbedBatches(
  inputs: string[],
  ubatchSize: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
): EmbedBatch[] {
  // Ensure ubatch_size is large enough for at least 1 token with safety margin
  const minUbatchSize = Math.ceil(1 / UBATCH_SAFETY_MARGIN)
  if (ubatchSize < minUbatchSize) {
    throw new Error(
      `ubatch_size (${ubatchSize}) is too small. Minimum required: ${minUbatchSize}`
    )
  }

  const safeLimit = Math.floor(ubatchSize * UBATCH_SAFETY_MARGIN)

  const batches: EmbedBatch[] = []
  let current: string[] = []
  let currentTokens = 0
  let offset = 0

  const push = () => {
    if (current.length) {
      batches.push({ batch: current, offset })
      offset += current.length
      current = []
      currentTokens = 0
    }
  }

  for (const text of inputs) {
    const estTokens = estimateTokensFromText(text, charsPerToken)

    // If single text exceeds safe limit, still allow it as single batch
    // (ensure at least one text per batch)
    if (estTokens > safeLimit) {
      if (current.length) push()
      batches.push({ batch: [text], offset })
      offset += 1
      continue
    }

    if (currentTokens + estTokens > safeLimit && current.length) {
      push()
    }

    current.push(text)
    currentTokens += estTokens
  }

  push()

  // Validate that no batch is empty
  if (batches.some(b => b.batch.length === 0)) {
    throw new Error('Internal error: empty batch detected')
  }

  return batches
}

export function mergeEmbedResponses(
  model: string,
  batchResults: Array<{ result: EmbedBatchResult; offset: number }>
) {
  const aggregated = {
    model,
    object: 'list',
    usage: { prompt_tokens: 0, total_tokens: 0 },
    data: [] as EmbedData[],
  }

  for (const { result, offset } of batchResults) {
    aggregated.usage.prompt_tokens += result.usage?.prompt_tokens ?? 0
    aggregated.usage.total_tokens += result.usage?.total_tokens ?? 0
    for (const item of result.data || []) {
      aggregated.data.push({ ...item, index: item.index + offset })
    }
  }

  return aggregated
}

/**
 * A GGUF quant too large for one file is published as `-00001-of-000NN` shards.
 * llama.cpp only accepts the *first* shard on `-m`: handed any other one it
 * bails with "illegal split file idx: N ... model must be loaded with the first
 * split", which reached users as an opaque "The model process encountered an
 * unexpected error".
 *
 * The marker shows up in two shapes, and both have to be recognised:
 *   - in the file name, as published:  `.../Model-00002-of-00003.gguf`
 *   - in the directory name, as this app stores a downloaded shard:
 *     `.../models/author/Model-00002-of-00003/model.gguf`
 */
const GGUF_SHARD_RE = /-(\d{5})-of-(\d{5})(?=\.gguf$|\/|$)/gi

export interface GgufShardRef {
  /** Position of this shard in the set, 1-based. */
  index: number
  /** How many shards the complete set has. */
  total: number
}

/** Locate the shard marker, or `null` when the path is not part of a set. */
function matchGgufShard(
  path: string
): (GgufShardRef & { start: number; end: number }) | null {
  // Reset: the regex is global, so `lastIndex` survives between calls.
  GGUF_SHARD_RE.lastIndex = 0
  let last: RegExpExecArray | null = null
  for (
    let match = GGUF_SHARD_RE.exec(path);
    match;
    match = GGUF_SHARD_RE.exec(path)
  ) {
    // A repo name may itself carry a `-00001-of-00002`-shaped token; the marker
    // that decides which file llama.cpp gets is the last one.
    last = match
  }
  if (!last) return null

  const index = Number(last[1])
  const total = Number(last[2])
  // `-00000-of-00003` is not a shard set anyone can load; treat it as a plain name.
  if (!index || !total || index > total) return null

  return { index, total, start: last.index, end: last.index + last[0].length }
}

/** Shard position of `path`, or `null` when it is a standalone model. */
export function parseGgufShard(path: string): GgufShardRef | null {
  const match = matchGgufShard(path)
  return match ? { index: match.index, total: match.total } : null
}

/**
 * The same path with its shard marker pointed at `index`. Returns `path`
 * untouched when it carries no marker.
 */
export function ggufShardPath(path: string, index: number): string {
  const match = matchGgufShard(path)
  if (!match) return path
  const marker = `-${String(index).padStart(5, '0')}-of-${String(
    match.total
  ).padStart(5, '0')}`
  return path.slice(0, match.start) + marker + path.slice(match.end)
}

/**
 * Every path in the shard set `path` belongs to, first shard first. A
 * standalone model yields just itself, so callers need no special case.
 */
export function ggufShardSetPaths(path: string): string[] {
  const match = matchGgufShard(path)
  if (!match) return [path]
  return Array.from({ length: match.total }, (_, i) =>
    ggufShardPath(path, i + 1)
  )
}

/**
 * The path llama.cpp has to be handed for this model: the first shard of the
 * set, or the path itself when it is not sharded.
 */
export function firstGgufShardPath(path: string): string {
  return ggufShardPath(path, 1)
}

/**
 * llama.cpp architectures that cannot generate text: encoder-only embedding
 * backbones and projector / audio side-models. Started as a chat model one
 * trips a GGML assertion and takes the server process down with it — the crash
 * users saw as "The model process crashed unexpectedly (access violation /
 * segfault)". Mirrors `NON_TEXT_GGUF_ARCHITECTURES` in the web-app's local
 * model scanner, which keeps the same weights out of onboarding.
 */
const NON_TEXT_GGUF_ARCHITECTURES = new Set([
  'bert',
  'modern-bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  'eurobert',
  'gemma-embedding',
  'llama-embed',
  't5encoder',
])

/**
 * Whether GGUF metadata describes weights that produce embeddings rather than
 * text. Such a model is still usable — it just has to be loaded in embedding
 * mode instead of being handed to the chat path.
 */
export function isEmbeddingGguf(
  metadata: Record<string, unknown> | undefined | null
): boolean {
  const raw = metadata?.['general.architecture']
  const arch = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!arch) return false
  if (NON_TEXT_GGUF_ARCHITECTURES.has(arch)) return true

  // Embedding / reranker conversions of a generative architecture (the
  // Qwen3-Embedding family and friends) keep the arch name and are only
  // distinguishable by a pooling type or a classifier head. Pooling type 0 is
  // NONE, i.e. a plain decoder.
  const pooling = metadata?.[`${arch}.pooling_type`]
  const poolingStr = pooling == null ? '' : String(pooling).trim()
  if (poolingStr !== '' && poolingStr !== '0') return true

  return metadata?.[`${arch}.classifier.output_labels`] !== undefined
}

/**
 * The context length to actually request, given what the user/config asked for
 * and what the model was trained on.
 *
 * llama.cpp does not clamp this itself: asked for more than `n_ctx_train` it
 * warns and then aborts on an assertion, killing the server process. Small
 * models are the ones that get hit, because the app's default (16384) is far
 * past the 512–2048 such models train at.
 *
 * Returns the request unchanged when the trained maximum is unknown — guessing
 * a smaller window would silently degrade models we simply have no metadata for.
 */
export function effectiveCtxSize(
  requested: number | undefined,
  maxCtxTrain: number | undefined
): number | undefined {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return requested
  }
  if (typeof maxCtxTrain !== 'number' || !Number.isFinite(maxCtxTrain)) {
    return requested
  }
  if (maxCtxTrain <= 0) return requested
  return Math.min(requested, maxCtxTrain)
}
