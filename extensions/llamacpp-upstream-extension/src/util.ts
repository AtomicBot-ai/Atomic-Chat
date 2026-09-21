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
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a model path is something to download rather than a file on disk.
 * `https://` always. Plain `http://` only from a loopback host — a mirror on
 * this machine, or a test fixture — where there is no network between the two
 * ends for anyone to stand in. Any other `http://` address stays what it was
 * before: not a URL this extension fetches, so it is looked up as a local path
 * and refused as a missing file.
 */
export function isDownloadableUrl(path: string): boolean {
  if (path.startsWith('https://')) return true
  if (!path.startsWith('http://')) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(path).hostname.toLowerCase())
  } catch {
    return false
  }
}

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
 * Which modality an mmproj carries.
 *
 * `general.architecture` is `clip` for *every* projector — vision and audio
 * alike — so the arch tells us nothing. The modality lives in the `clip.*` keys
 * that `libmtmd` writes, and until now the extension simply assumed any mmproj
 * meant vision. That is wrong for Voxtral, whose projector is a Whisper-style
 * audio encoder.
 *
 * Unknown metadata falls back to vision, which is what the code did before this
 * function existed — a projector we cannot classify must not silently lose its
 * existing capability.
 */
export function classifyProjector(
  metadata: Record<string, unknown> | undefined | null
): { vision: boolean; audio: boolean } {
  if (!metadata) return { vision: true, audio: false }

  const truthy = (value: unknown): boolean =>
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  const present = (value: unknown): boolean =>
    value !== undefined && value !== null && String(value).trim() !== ''

  const vision =
    truthy(metadata['clip.has_vision_encoder']) ||
    present(metadata['clip.vision.projector_type'])
  const audio =
    truthy(metadata['clip.has_audio_encoder']) ||
    present(metadata['clip.audio.projector_type'])

  if (!vision && !audio) return { vision: true, audio: false }
  return { vision, audio }
}
