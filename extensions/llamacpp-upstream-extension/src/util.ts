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

/**
 * True iff `vb` is a CONCRETE `<version>/<backend>` string. Excludes empty,
 * `'none'`, no-slash, and the unresolved `latest/<backend>` sentinel. Strips
 * BOM / surrounding whitespace before checking (ATO-124).
 *
 * The bug this guards against: `version_backend.includes('/')` was used as a
 * proxy for "backend is resolved", but the sentinel `latest/<backend>` also
 * contains a `/` and passed that check, so the load path started before the
 * sentinel was resolved to a real release tag → `ensureBackendReady('latest')`
 * → `downloadAndInstallBackend` throws on the `version === 'latest'` guard →
 * web-app auto-restarts → tight retry-loop.
 */
export function isConcreteVersionBackend(
  vb: string | undefined | null
): boolean {
  const v = (vb ?? '').replace(/\uFEFF/g, '').trim()
  if (!v || v === 'none') return false
  if (!v.includes('/')) return false
  if (v.startsWith('latest/')) return false
  return true
}

/**
 * ATO-185: structured error code for "host CPU lacks the SIMD baseline the
 * shipped ggml-org CPU build requires". Surfaced to the web-app load-error
 * handler so it can render a clear, actionable message instead of the opaque
 * generic LLAMA_CPP_PROCESS_ERROR a silent SIGILL crash produces.
 */
export const CPU_NO_AVX_ERROR_CODE = 'CPU_NO_AVX'

/**
 * True iff `backend` is one of the CPU-only backend builds (no GPU offload).
 * Matches `win-cpu-x64`, `win-cpu-arm64`, `linux-cpu-x64`, `linux-cpu-arm64`.
 * The macOS backends (`macos-x64` / `macos-arm64`) deliberately do NOT match —
 * macOS is unaffected by the AVX issue (Apple Silicon has no AVX concept and
 * Intel Macs all ship AVX).
 */
export function isCpuBackend(backend: string | undefined | null): boolean {
  const b = (backend ?? '').replace(/\uFEFF/g, '').trim().toLowerCase()
  return b.includes('-cpu-')
}

/**
 * True iff the detected CPU extension list reports at least AVX. The shipped
 * ggml-org CPU build's lowest variant requires AVX (the "sandybridge" tier);
 * AVX2 / AVX-512 imply AVX. Mirrors the web-app `cpuAvxLevel` classification.
 */
export function cpuHasAvx(extensions: string[] | undefined | null): boolean {
  if (!extensions || extensions.length === 0) return false
  return extensions.some((e) => {
    const x = e.toLowerCase()
    return x === 'avx' || x === 'avx2' || x.startsWith('avx512')
  })
}

/**
 * ATO-185: decide whether to block a CPU-backend load because the host CPU is
 * too old to run the shipped binary. The shipped ggml-org CPU build executes
 * AVX instructions unconditionally, so an x86 CPU with no AVX at all dies with
 * SIGILL (Unix signal 4 / Windows STATUS_ILLEGAL_INSTRUCTION) the moment it
 * starts — leaving empty stderr that only surfaced as the opaque generic
 * LLAMA_CPP_PROCESS_ERROR (PostHog 30d: cpu_avx='none' fails 31.6% vs avx
 * 0.39%). We block only when we have a POSITIVE no-AVX signal: x86 arch, a
 * CPU backend, and a non-empty extension list that lacks AVX. An empty list
 * (non-x86 host or a hardware-probe failure) is never treated as "no AVX", so
 * we never false-block a capable machine.
 */
export function isUnsupportedNoAvxCpu(
  arch: string | undefined | null,
  backend: string | undefined | null,
  extensions: string[] | undefined | null
): boolean {
  const a = (arch ?? '').trim().toLowerCase()
  const isX86 = a === 'x86_64' || a === 'x86' || a === 'amd64'
  if (!isX86) return false
  if (!isCpuBackend(backend)) return false
  if (!extensions || extensions.length === 0) return false
  return !cpuHasAvx(extensions)
}

/**
 * True iff the load-error text is an MTP-rejection (MTP requested on a model
 * with no MTP layers / no draft head). llama.cpp surfaces no structured error
 * code for this, so we match the stderr text (ATO-125).
 */
export function matchesMtpLoadFailure(text: string): boolean {
  if (!text) return false
  return (
    /failed to create MTP context/i.test(text) ||
    /context type MTP requested/i.test(text) ||
    /doesn'?t contain MTP layers/i.test(text)
  )
}

const EMBEDDED_MTP_ARCHITECTURES = new Set(['qwen35', 'qwen35moe'])

/**
 * Detect a combined Qwen GGUF whose MTP head is embedded in the target file.
 * llama.cpp derives the same split from `{arch}.block_count` and
 * `{arch}.nextn_predict_layers`; filenames and repository names are not part
 * of the model format contract.
 */
export function hasEmbeddedMtp(
  metadata: Record<string, unknown> | undefined | null
): boolean {
  if (!metadata) return false

  const architecture = metadata['general.architecture']
  if (
    typeof architecture !== 'string' ||
    !EMBEDDED_MTP_ARCHITECTURES.has(architecture)
  ) {
    return false
  }

  const blockCount = Number(metadata[`${architecture}.block_count`])
  const nextnPredictLayers = Number(
    metadata[`${architecture}.nextn_predict_layers`]
  )

  return (
    Number.isInteger(blockCount) &&
    Number.isInteger(nextnPredictLayers) &&
    nextnPredictLayers > 0 &&
    blockCount > nextnPredictLayers
  )
}

export function isMtpCapable(
  metadata: Record<string, unknown> | undefined | null,
  mtpDraftPath: string
): boolean {
  return mtpDraftPath.length > 0 || hasEmbeddedMtp(metadata)
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
  'vulkan',
])

export function isGpuBackendCategory(category: string): boolean {
  return GPU_BACKEND_CATEGORIES.has(category)
}

/**
 * Which GPU stack a build targets. A CUDA build on the CPU and a Vulkan build
 * on the CPU need different advice: install the NVIDIA CUDA runtime versus
 * install/update the Vulkan driver, which on Linux is also the only GPU path
 * for AMD and Intel.
 */
export type GpuKind = 'cuda' | 'vulkan' | 'other'

export function gpuKindOf(category: string): GpuKind {
  if (category.startsWith('cuda-')) return 'cuda'
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
 * Compare what the UI shows, what was launched and what the process reports.
 * `categoryOf` is injected because the two providers use different backend id
 * schemes (`win-cuda-13.3-x64` vs `windows-x64-cuda-13.3`).
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
    runtimeRanOnCpu(input.runtimeDevice)
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
