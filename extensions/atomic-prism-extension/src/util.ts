/**
 * True iff `vb` is a CONCRETE `<version>/<backend>` string. Excludes empty,
 * `'none'`, no-slash, and the unresolved `latest/<backend>` sentinel. Strips
 * BOM / surrounding whitespace before checking (ATO-124).
 *
 * `version_backend.includes('/')` is not enough on its own: the sentinel
 * `latest/<backend>` also contains a `/`, and treating it as resolved started
 * a load before any real release tag was known.
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
 * llama.cpp only accepts the *first* shard on `-m`, and finds the rest by their
 * published file names.
 *
 * The marker shows up in two shapes, and both have to be recognised:
 *   - in the file name, as published:  `.../Model-00002-of-00003.gguf`
 *   - in the directory name, as this app stores a downloaded shard:
 *     `.../models/author/Model-00002-of-00003/model.gguf`
 */
const GGUF_SHARD_RE = /-(\d{5})-of-(\d{5})(?=\.gguf$|\/|$)/gi

/** Locate the shard marker, or `null` when the path is not part of a set. */
function matchGgufShard(
  path: string
): { index: number; total: number; start: number; end: number } | null {
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

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a model path is something to download rather than a file on disk.
 * `https://` always. Plain `http://` only from a loopback host — a mirror on
 * this machine, or a test fixture — where there is no network between the two
 * ends for anyone to stand in.
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

/**
 * The same path with its shard marker pointed at `index`. Returns `path`
 * untouched when it carries no marker.
 */
function ggufShardPath(path: string, index: number): string {
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
 * Whether an mmproj carries a vision encoder.
 *
 * `general.architecture` is `clip` for *every* projector — vision and audio
 * alike — so the arch tells us nothing. The modality lives in the `clip.*` keys
 * that `libmtmd` writes. Unknown metadata falls back to vision, so a projector
 * that cannot be classified does not silently lose its capability.
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
