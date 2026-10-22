import { useDownloadStore, type DownloadProgressProps, type DownloadResumeParams } from '@/hooks/useDownloadStore'
import { modelDownloadKey, publicSource } from '@/lib/downloadRecovery'
import { newSpeedSample } from '@/lib/downloadFormat'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

type Blocked = NonNullable<DownloadProgressProps['recoveryBlocked']>
export interface RecoveryStat { isDirectory: boolean; size: number }
export interface RecoveryIo {
  list(path: string): Promise<string[]>
  stat(path: string): Promise<RecoveryStat | null>
  readText(path: string): Promise<string | null>
}
export interface RecoveryRoot { path: string; provider: string }
export interface LegacyDownloadCandidate {
  id: string
  params?: DownloadResumeParams
  current: number
  total: number
  origin?: string
  blocked?: Blocked
  /** Verified weight identity when only a completed projector lacks its sidecar. */
  completedProjectorWeightsKey?: string
}
export interface LegacyScanResult { candidates: LegacyDownloadCandidate[]; truncated: boolean }

const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '')
const MAX_ENTRIES = 10000
const MAX_DEPTH = 12
const MAX_METADATA_BYTES = 512 * 1024
const safeId = (value: string) => /^[A-Za-z0-9/_.-]+$/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..')

/** Read only small sidecars; never open a model or a partial payload. */
export async function scanLegacyModelDownloads(io: RecoveryIo, roots: RecoveryRoot[]): Promise<LegacyScanResult> {
  const result: LegacyScanResult = { candidates: [], truncated: false }
  let visited = 0
  for (const root of roots) {
    const base = normalize(root.path)
    const rootStat = await io.stat(base).catch(() => null)
    if (!rootStat?.isDirectory) continue
    const files = new Map<string, RecoveryStat>()
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) { result.truncated = true; return }
      let children: string[]
      try { children = await io.list(directory) } catch { result.truncated = true; return }
      for (const child of children.sort()) {
        if (++visited > MAX_ENTRIES) { result.truncated = true; return }
        const path = normalize(child)
        // The existing Tauri readdir command returns absolute child paths.
        if (!path.startsWith(directory + '/') || path.slice(directory.length + 1).includes('/')) continue
        const stat = await io.stat(path).catch(() => null)
        if (!stat) continue
        if (stat.isDirectory) await walk(path, depth + 1)
        else files.set(path, stat)
      }
    }
    await walk(base, 0)
    const text = async (path: string) => {
      const stat = files.get(path)
      return stat && stat.size <= MAX_METADATA_BYTES ? io.readText(path).catch(() => null) : null
    }
    type Artifact = { target: string; source?: string; current: number; total: number; blocked?: Blocked }
    const groups = new Map<string, Artifact[]>()
    const targets = new Set([...files.keys()].filter((path) => /\.(tmp|url|parts)$/.test(path)).map((path) => path.replace(/\.(tmp|url|parts)$/, '')))
    for (const target of targets) {
      const urlText = await text(target + '.url')
      let source = publicSource(urlText) ? urlText : undefined
      let current = files.get(target + '.tmp')?.size ?? 0
      let total = 0
      let blocked: Blocked | undefined = source ? undefined : 'missing_source'
      if (files.has(target + '.parts')) {
        current = 0 // Segmented .tmp files are preallocated; their length is not progress.
        try {
          const map = JSON.parse((await text(target + '.parts')) ?? 'null')
          if (!map || map.version !== 1 || !publicSource(map.url) || (source && map.url !== source) || !Number.isSafeInteger(map.size) || map.size <= 0 || !Array.isArray(map.segments) || !map.segments.length) throw Error('Invalid map')
          let end = 0
          const ranges = map.segments.map((segment: unknown) => {
            if (!Array.isArray(segment) || segment.length !== 3 || !segment.every(Number.isSafeInteger)) throw Error('Invalid segment')
            return segment as number[]
          }).sort(([left]: number[], [right]: number[]) => left - right)
          for (const segment of ranges) {
            const [start, written, stop] = segment
            if (start !== end || written < start || written > stop || stop <= start || stop > map.size) throw Error('Invalid range')
            current += written - start
            end = stop
          }
          if (end !== map.size || files.get(target + '.tmp')?.size !== map.size) throw Error('Wrong file size')
          total = map.size
          if (!source && !files.has(target + '.url')) { source = map.url; blocked = undefined }
        } catch { blocked = 'invalid_manifest'; current = 0 }
      }
      // A completed payload wins over obsolete partial/map counters. Do not
      // count a preallocated .tmp as completed data.
      const completed = files.get(target)
      if (completed && !completed.isDirectory) {
        current = completed.size
        total = completed.size
      }
      let relative = target.slice(base.length + 1)
      let id = relative.slice(0, relative.lastIndexOf('/'))
      if (root.provider === 'mlx' && source) {
        const match = new URL(source).pathname.match(/^\/[^/]+\/[^/]+\/resolve\/[^/]+\/(.+)$/)
        let filename = ''
        try { filename = decodeURIComponent(match?.[1] ?? '') } catch { /* Invalid names remain blocked. */ }
        if (filename && relative.endsWith('/' + filename)) {
          relative = relative.slice(0, -(filename.length + 1))
          id = relative
        } else blocked = 'unsupported_layout'
      }
      if (!safeId(id)) continue
      const artifacts = groups.get(id) ?? []
      artifacts.push({ target, source, current, total, blocked })
      groups.set(id, artifacts)
    }
    for (const [id, artifacts] of groups) {
      // Completed shards/projectors lose their sidecars. Include their actual
      // lengths at startup, exactly once, so Resume does not appear to add GB.
      const directory = base + '/' + id
      const knownTargets = new Set(artifacts.map((file) => file.target))
      for (const [target, stat] of files) {
        if (target.slice(0, target.lastIndexOf('/')) !== directory || knownTargets.has(target)) continue
        const name = target.slice(directory.length + 1)
        if (root.provider === 'mlx' || !/^(model\.gguf|mmproj\.gguf|.+-\d{5}-of-\d{5}\.gguf)$/.test(name)) continue
        artifacts.push({ target, current: stat.size, total: stat.size })
      }
      const candidate: LegacyDownloadCandidate = {
        id, current: artifacts.reduce((n, file) => n + file.current, 0),
        total: artifacts.every((file) => file.total > 0) ? artifacts.reduce((n, file) => n + file.total, 0) : 0,
        blocked: artifacts.find((file) => file.blocked)?.blocked,
      }
      if (files.has(directory + '/model.yml')) candidate.blocked = 'installed_model'
      const sources = artifacts.filter((file) => file.source)
      if (root.provider === 'mlx') {
        const first = sources[0]?.source
        if (first) {
          candidate.params = { modelPath: first, provider: 'mlx', recoverRepository: true, skipVerification: true }
          if (sources.some((file) => modelDownloadKey({ modelPath: file.source!, provider: 'mlx' }) !== modelDownloadKey(candidate.params!))) candidate.blocked = 'source_conflict'
        }
      } else {
        const weights = sources.filter((file) => /\.gguf$/.test(new URL(file.source!).pathname) && !/mmproj/i.test(file.target.split('/').pop() ?? ''))
        const first = weights[0]?.source
        if (first) {
          const primaryTarget = weights[0].target.split('/').pop() ?? ''
          if (primaryTarget !== 'model.gguf' && !/-\d{5}-of-\d{5}\.gguf$/.test(primaryTarget)) candidate.blocked = 'unsupported_layout'
          candidate.params = {
            modelPath: first, provider: root.provider, skipVerification: true,
            mmprojPath: sources.find((file) => /mmproj/i.test(file.target.split('/').pop() ?? ''))?.source,
          }
          if (weights.some((file) => modelDownloadKey({ modelPath: file.source!, provider: root.provider }) !== modelDownloadKey(candidate.params!))) candidate.blocked = 'source_conflict'
          // A finished projector has no sidecar URL. Do not overwrite or silently omit it.
          if (!candidate.blocked && files.has(directory + '/mmproj.gguf') && !candidate.params.mmprojPath) {
            candidate.completedProjectorWeightsKey = modelDownloadKey(candidate.params)
            candidate.blocked = 'missing_source'
          }
        }
      }
      if (!candidate.params) candidate.blocked ??= 'missing_source'
      if (candidate.params) {
        const url = new URL(candidate.params.modelPath)
        candidate.origin = url.pathname.split('/').slice(1, 3).join('/')
      }
      if (candidate.blocked) candidate.params = undefined
      result.candidates.push(candidate)
    }
  }
  return result
}

/** Merge after the scan, using the live store so a just-started transfer is never replaced. */
export function mergeLegacyModelDownloads(result: LegacyScanResult): void {
  for (const candidate of result.candidates) {
    const state = useDownloadStore.getState()
    if (state.dismissedDownloads.has(candidate.id)) continue
    if (state.localDownloadingModels.has(candidate.id) ||
      (state.downloads[candidate.id] && !state.pausedDownloads.has(candidate.id))) continue
    const existing = state.resumeParams[candidate.id]
    if (existing && candidate.params && modelDownloadKey(existing) !== modelDownloadKey(candidate.params)) {
      // The old store keys by display id. Preserve both sources visibly rather than
      // let a second provider silently take over that id's destination.
      const conflictId = `legacy-${candidate.params.provider}/${candidate.id}`
      state.updateProgress(conflictId, 0, conflictId, candidate.current, candidate.total)
      state.markPausedDownload(conflictId)
      useDownloadStore.setState((current) => ({ downloads: {
        ...current.downloads, [conflictId]: { ...current.downloads[conflictId], recoveryBlocked: 'source_conflict' },
      } }))
      continue
    }
    // Completed projectors deliberately lose their transfer sidecars. A safe
    // persisted request still knows their URL; discovery must not erase it.
    // Require matching validated weight identity and the specific projector-only
    // gap: malformed maps, unknown partials and source conflicts stay blocked.
    const journalCoversProjector = existing && publicSource(existing.mmprojPath) &&
      candidate.blocked === 'missing_source' &&
      candidate.completedProjectorWeightsKey === modelDownloadKey(existing)
    if (existing && (!candidate.blocked || journalCoversProjector)) {
      // On-disk counters supersede a stale crash-time snapshot, but not live progress.
      const total = Math.max(candidate.total, state.downloads[candidate.id]?.total ?? 0)
      state.updateProgress(candidate.id, total > 0 ? Math.min(candidate.current / total, 1) : 0, candidate.id, candidate.current, total)
      useDownloadStore.setState((current) => ({ downloads: {
        ...current.downloads, [candidate.id]: { ...current.downloads[candidate.id], speed: newSpeedSample(candidate.current) },
      } }))
      continue
    }
    if (candidate.params && Object.values(state.resumeParams).some((params) => modelDownloadKey(params) === modelDownloadKey(candidate.params!))) continue
    if (candidate.blocked) state.clearResumeParams(candidate.id)
    if (candidate.params) state.setResumeParams(candidate.id, candidate.params)
    state.updateProgress(candidate.id, candidate.total > 0 ? candidate.current / candidate.total : 0, candidate.id, candidate.current, candidate.total)
    state.markPausedDownload(candidate.id)
    state.markResumableDownload(candidate.id)
    if (candidate.origin) state.setDownloadOrigin(candidate.id, candidate.origin)
    if (candidate.blocked) {
      useDownloadStore.setState((current) => ({ downloads: {
        ...current.downloads, [candidate.id]: { ...current.downloads[candidate.id], recoveryBlocked: candidate.blocked, speed: newSpeedSample(candidate.current) },
      } }))
    }
  }
}

type RecoveryServices = {
  app(): { getJanDataFolder(): Promise<string | undefined> }
  core(): { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
}
const startupJobs = new WeakMap<RecoveryServices, Promise<void>>()
let startupRecovery: Promise<void> = Promise.resolve()

/** Start on application mount; this performs no HTTP requests and no filesystem writes. */
export function beginLegacyDownloadRecovery(hub: RecoveryServices): Promise<void> {
  const previous = startupJobs.get(hub)
  if (previous) return previous
  const job = (async () => {
    const folder = await hub.app().getJanDataFolder()
    if (!folder) return
    const core = hub.core()
    const io: RecoveryIo = {
      list: (path) => core.invoke<string[]>('readdir_sync', { args: [path] }),
      stat: (path) => core.invoke<RecoveryStat>('file_stat', { args: path }),
      readText: (path) => core.invoke<string>('read_file_sync', { args: [path] }),
    }
    const roots = [
      { path: normalize(folder) + '/llamacpp/models', provider: LOCAL_LLAMACPP_PROVIDER },
      { path: normalize(folder) + '/mlx/models', provider: 'mlx' },
    ]
    const result = await scanLegacyModelDownloads(io, roots)
    // Completion can land immediately before an app exit. Retire stale journal
    // descriptions only when an installed model exists and no partial was found.
    for (const [id, params] of Object.entries(result.truncated ? {} : useDownloadStore.getState().resumeParams)) {
      if (useDownloadStore.getState().localDownloadingModels.has(id) || result.candidates.some((candidate) => candidate.id === id)) continue
      const provider = params.provider === 'mlx' ? 'mlx' : LOCAL_LLAMACPP_PROVIDER
      const root = roots.find((entry) => entry.provider === provider)
      if (!root || !safeId(id)) continue
      const installed = await io.stat(root.path + '/' + id + '/model.yml').catch(() => null)
      if (!installed || installed.isDirectory) continue
      const state = useDownloadStore.getState()
      if (state.localDownloadingModels.has(id)) continue
      state.clearResumeParams(id)
      state.clearPausedDownload(id)
      state.clearResumableDownload(id)
      state.clearDownloadOrigin(id)
      state.removeDownload(id)
    }
    mergeLegacyModelDownloads(result)
    if (result.truncated) console.warn('[Atomic Chat] Legacy model download scan could not inspect every folder')
  })().catch(() => { console.warn('[Atomic Chat] Legacy model download recovery could not finish') })
  startupJobs.set(hub, job)
  startupRecovery = job
  return job
}

export function waitForLegacyDownloadRecovery(): Promise<void> { return startupRecovery }
