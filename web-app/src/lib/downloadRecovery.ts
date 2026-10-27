import type { DownloadResumeParams, DownloadState } from '@/hooks/useDownloadStore'
import { newSpeedSample } from './downloadFormat'

/** HF revision and file names are case-sensitive. Never reduce identity to a display id. */
function sourceKey(path: string): string {
  try {
    const url = new URL(path)
    if (url.hostname === 'huggingface.co' || url.hostname === 'hf.co') {
      return `https://huggingface.co${url.pathname.replace(/-\d{5}-of-(\d{5})\.gguf$/, '-all-of-$1.gguf')}`
    }
  } catch { /* Local imports retain their exact source. */ }
  return path
}

export function modelDownloadKey(params: DownloadResumeParams): string {
  const provider = params.provider === 'llamacpp' || params.provider === 'llamacpp-upstream' || params.provider === 'atomic-prism'
    ? 'llamacpp' : params.provider ?? 'llamacpp'
  const source = sourceKey(params.modelPath)
  // MLX downloads the whole repository; which safetensors file was listed first is immaterial.
  return JSON.stringify([provider, provider === 'mlx'
    ? source.replace(/(\/resolve\/[^/]+\/).+$/, '$1') : source])
}

type Entry = {
  id: string
  params: DownloadResumeParams
  current: number
  total: number
  origin?: string
}
export type DownloadRecovery = { entries: Entry[]; dismissed?: string[] }

export function publicSource(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      ['huggingface.co', 'hf.co'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/[^/]+\/[^/]+\/resolve\/[^/]+\/.+/.test(url.pathname)
  } catch { return false }
}

/** Allowlist durable parameters: never persist tokens, signed URLs or transient intent. */
function safeParams(value: unknown): DownloadResumeParams | undefined {
  if (!value || typeof value !== 'object') return
  const p = value as DownloadResumeParams
  if (!publicSource(p.modelPath) || (p.mmprojPath && !publicSource(p.mmprojPath))) return
  if (p.provider !== undefined && !['llamacpp', 'llamacpp-upstream', 'atomic-prism', 'mlx'].includes(p.provider)) return
  if (p.files !== undefined && (!Array.isArray(p.files) || p.files.some((f) =>
    !f || !publicSource(f.url) || typeof f.filename !== 'string' ||
    f.filename.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  ))) return
  return {
    modelPath: p.modelPath,
    mmprojPath: p.mmprojPath,
    provider: p.provider,
    recoverRepository: p.recoverRepository === true,
    files: p.files?.map(({ url, filename }) => ({ url, filename })),
    skipVerification: p.skipVerification === true,
    modelSha256: typeof p.modelSha256 === 'string' ? p.modelSha256 : undefined,
    modelSize: Number.isFinite(p.modelSize) && p.modelSize! >= 0 ? p.modelSize : undefined,
    mmprojSha256: typeof p.mmprojSha256 === 'string' ? p.mmprojSha256 : undefined,
    mmprojSize: Number.isFinite(p.mmprojSize) && p.mmprojSize! >= 0 ? p.mmprojSize : undefined,
  }
}

const bytes = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

export function saveDownloadRecovery(state: DownloadState): DownloadRecovery {
  return { dismissed: [...state.dismissedDownloads], entries: Object.entries(state.resumeParams).flatMap(([id, value]) => {
    const params = safeParams(value)
    if (!params) return []
    const progress = state.downloads[id]
    return [{ id, params, current: bytes(progress?.current), total: bytes(progress?.total), origin: state.downloadOriginByModelId[id] }]
  }) }
}

/** Restore descriptions only. The downloader, not cached counters, validates disk offsets. */
export function restoreDownloadRecovery(value: unknown): Partial<DownloadState> {
  const restored: Partial<DownloadState> = {
    downloads: {}, resumeParams: {}, pausedDownloads: new Set(),
    resumableDownloads: new Set(), localDownloadingModels: new Set(), dismissedDownloads: new Set(),
    downloadOriginByModelId: {}, downloadRequestOriginByModelId: {},
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as DownloadRecovery).entries)) return restored
  const dismissed = (value as DownloadRecovery).dismissed
  if (Array.isArray(dismissed)) {
    for (const id of dismissed) {
      if (typeof id === 'string' && /^[A-Za-z0-9/_\-.]+$/.test(id) &&
        id.split('/').every((part) => part && part !== '.' && part !== '..')) restored.dismissedDownloads!.add(id)
    }
  }
  const identities = new Set<string>()
  for (const entry of (value as DownloadRecovery).entries) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9/_\-.]+$/.test(entry.id) ||
      entry.id.split('/').some((part) => !part || part === '.' || part === '..')) continue
    const params = safeParams(entry.params)
    if (!params) continue
    const key = modelDownloadKey(params)
    if (identities.has(key) || Object.prototype.hasOwnProperty.call(restored.resumeParams, entry.id)) continue
    identities.add(key)
    const current = bytes(entry.current), total = bytes(entry.total)
    restored.resumeParams![entry.id] = params
    // Retain only the safe source mapping for an explicit later re-download.
    if (restored.dismissedDownloads!.has(entry.id)) continue
    restored.downloads![entry.id] = {
      id: entry.id, name: entry.id, current, total,
      progress: total > 0 ? Math.min(current / total, 1) : 0,
      speed: newSpeedSample(current),
    }
    restored.pausedDownloads!.add(entry.id)
    restored.resumableDownloads!.add(entry.id)
    if (typeof entry.origin === 'string') restored.downloadOriginByModelId![entry.id] = entry.origin
    restored.downloadRequestOriginByModelId![entry.id] = 'standalone'
  }
  return restored
}
