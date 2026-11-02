/** Prepare and persist immutable HF file plans before any downloader opens a file. */
import { ATOMIC_COMMIT_RE, type AtomicModelCatalog } from './catalogProtocol'
import { atomicModelCatalogSnapshot } from './modelCatalog'

export interface AtomicTransferItem {
  url: string
  save_path: string
  size?: number | null
  sha256?: string | null
  resume_key?: string
  source?: AtomicDownloadSource
  purpose?: string
}
export interface AtomicDownloadSource {
  repo: string
  revision: string
  path: string
}
export interface AtomicDownloadPlan<T extends AtomicTransferItem = AtomicTransferItem> {
  version: 1
  files: Array<T & { source?: AtomicDownloadSource }>
}
export interface AtomicDownloadOptions {
  fetch?: typeof fetch
  token?: string
  signal?: AbortSignal
  revisionFor?: (repo: string) => string | undefined
  expandGguf?: boolean
}

const CANCEL_EVENT = 'atomic-model-preparation-cancel'
const METADATA_FETCH = Symbol.for('atomic.model-metadata.fetch')

/** The app supplies its existing native/proxy transport; bundles share it without a runtime dependency. */
export function configureAtomicModelMetadataFetch(request: typeof fetch): void {
  Reflect.set(globalThis, METADATA_FETCH, request)
}

export function atomicModelMetadataFetch(): typeof fetch {
  return (Reflect.get(globalThis, METADATA_FETCH) as typeof fetch | undefined) ?? fetch
}

/** Bundled extensions and the app share cancellation even before transfer starts. */
export function beginAtomicModelPreparation(id: string) {
  const controller = new AbortController()
  const cancel = (event: Event) => {
    if ((event as CustomEvent<string>).detail === id) controller.abort()
  }
  globalThis.addEventListener(CANCEL_EVENT, cancel)
  return {
    signal: controller.signal,
    finish: () => globalThis.removeEventListener(CANCEL_EVENT, cancel),
  }
}

export function cancelAtomicModelPreparation(id: string): void {
  globalThis.dispatchEvent(new CustomEvent(CANCEL_EVENT, { detail: id }))
}

/** Only model resolve URLs are subject to the HF contract; engine archives keep their own protocol. */
export function atomicHfSource(value: string): AtomicDownloadSource | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!['huggingface.co', 'hf.co'].includes(url.hostname)) return undefined
  const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/)
  if (!match) return undefined
  const path = decodeURIComponent(match[3])
  if (
    /[\u0000-\u001f]/.test(path) ||
    path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Invalid Hugging Face file path')
  const repo = match[1].split('/').map(decodeURIComponent).join('/')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('Invalid Hugging Face repository')
  return { repo, revision: decodeURIComponent(match[2]), path }
}

function catalogFile(catalog: AtomicModelCatalog | undefined, source: AtomicDownloadSource) {
  for (const entry of Object.values(catalog?.models ?? {})) {
    if (
      (entry.definition.model_name ?? entry.definition.repo) !== source.repo ||
      entry.definition.revision !== source.revision
    )
      continue
    const file = entry.files?.find((file) => file.path === source.path)
    if (file) return file
    const variant = Object.values(entry.variants).find(
      (file) => file.path === source.path && Number.isSafeInteger(file.size)
    )
    if (variant) return variant as { size: number; sha256?: string }
  }
  return undefined
}

/** Metadata and URLs come from the same resolved commit, including every shard and projector. */
export async function prepareAtomicDownload<T extends AtomicTransferItem>(
  items: readonly T[],
  options: AtomicDownloadOptions = {}
): Promise<AtomicDownloadPlan<T>> {
  const request = options.fetch ?? atomicModelMetadataFetch()
  const curated = options.revisionFor ? undefined : atomicModelCatalogSnapshot()
  const revisions = new Map<
    string,
    Promise<{
      sha: string
      siblings: Array<{ rfilename: string; size?: number; lfs?: { size: number; sha256: string } }>
    }>
  >()
  const selected = options.expandGguf
    ? items.flatMap((item) => {
        const source = atomicHfSource(item.url)
        const marker = source?.path.match(/-(\d{5})-of-(\d{5})(?=\.gguf$)/i)
        if (!source || !marker) return [item]
        if (Number(marker[1]) < 1 || Number(marker[1]) > Number(marker[2]))
          throw new Error('Invalid GGUF shard set')
        return Array.from({ length: Number(marker[2]) }, (_, index) => {
          const path = source.path.replace(
            marker[0],
            `-${String(index + 1).padStart(5, '0')}-of-${marker[2]}`
          )
          return {
            ...item,
            url: `https://huggingface.co/${source.repo}/resolve/${encodeURIComponent(source.revision)}/${path.split('/').map(encodeURIComponent).join('/')}`,
            save_path: item.save_path.replace(/[^/]+$/, path.split('/').pop()!),
            ...(path === source.path ? {} : { size: undefined, sha256: undefined }),
          }
        })
      })
    : items
  const files = await Promise.all(
    selected.map(async (item) => {
      const source = atomicHfSource(item.url)
      if (!source) return { ...item }
      const ref = ATOMIC_COMMIT_RE.test(source.revision)
        ? source.revision
        : source.revision === 'main'
          ? (options.revisionFor?.(source.repo) ?? 'main')
          : source.revision
      const key = `${source.repo}@${ref}`
      let reading = revisions.get(key)
      if (!reading) {
        reading = (async () => {
          const response = await request(
            `https://huggingface.co/api/models/${source.repo}/revision/${encodeURIComponent(ref)}?blobs=true&files_metadata=true`,
            {
              ...(options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {}),
              signal: options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
                : AbortSignal.timeout(30000),
            }
          )
          if (!response.ok)
            throw new Error(
              `Hugging Face metadata returned HTTP ${response.status} for ${source.repo}@${ref}`
            )
          const data = (await response.json()) as {
            sha?: string
            siblings?: Array<{
              rfilename: string
              size?: number
              lfs?: { size: number; sha256: string }
            }>
          }
          if (
            !data.sha ||
            !ATOMIC_COMMIT_RE.test(data.sha) ||
            !Array.isArray(data.siblings) ||
            (ATOMIC_COMMIT_RE.test(ref) && data.sha !== ref)
          )
            throw new Error(`Hugging Face did not confirm commit ${source.repo}@${ref}`)
          return { sha: data.sha, siblings: data.siblings }
        })()
        revisions.set(key, reading)
      }
      const data = await reading
      const declared = catalogFile(curated, { ...source, revision: data.sha })
      const file = data.siblings.find((f) => f.rfilename === source.path)
      if (!file) throw new Error(`Missing file ${source.path} at ${source.repo}@${data.sha}`)
      const size = file.lfs?.size ?? file.size
      if (!Number.isSafeInteger(size) || (size as number) < 0)
        throw new Error(`Missing file size for ${source.path}`)
      const expectedSize = item.size ?? declared?.size
      const expectedHash = item.sha256 ?? declared?.sha256
      if (expectedSize !== undefined && expectedSize !== size)
        throw new Error(`Catalog size disagrees with ${source.repo}@${data.sha}/${source.path}`)
      if (expectedHash && file.lfs?.sha256 && expectedHash !== file.lfs.sha256)
        throw new Error(`Catalog hash disagrees with ${source.repo}@${data.sha}/${source.path}`)
      const hash = expectedHash ?? file.lfs?.sha256
      if (hash && !/^[0-9a-f]{64}$/.test(hash))
        throw new Error(`Invalid file hash for ${source.path}`)
      const pinned = { ...source, revision: data.sha }
      return {
        ...item,
        url: `https://huggingface.co/${source.repo}/resolve/${data.sha}/${source.path.split('/').map(encodeURIComponent).join('/')}`,
        size: size as number,
        ...(hash ? { sha256: hash } : {}),
        source: pinned,
        purpose:
          item.purpose ??
          (/mmproj/i.test(source.path)
            ? 'projector'
            : /\.(gguf|safetensors)$/i.test(source.path)
              ? 'weights'
              : 'configuration'),
      }
    })
  )
  return { version: 1, files }
}

const planKey = (id: string) => `atomic_model_download_plan_v1:${id}`

function plannedFile(item: AtomicTransferItem): boolean {
  const source = atomicHfSource(item.url)
  return (
    !!source &&
    ATOMIC_COMMIT_RE.test(source.revision) &&
    Number.isSafeInteger(item.size) &&
    (item.size as number) >= 0 &&
    (!item.sha256 || /^[0-9a-f]{64}$/.test(item.sha256)) &&
    source.revision === item.source?.revision &&
    source.repo === item.source.repo &&
    source.path === item.source.path
  )
}

/** Validate persisted pins instead of trusting localStorage to contain a complete plan. */
export function readAtomicDownloadPlan<T extends AtomicTransferItem = AtomicTransferItem>(
  id: string
): AtomicDownloadPlan<T> | undefined {
  try {
    const plan = JSON.parse(
      localStorage.getItem(planKey(id)) ?? 'null'
    ) as AtomicDownloadPlan<T> | null
    if (plan?.version !== 1 || !Array.isArray(plan.files) || !plan.files.length) return undefined
    for (const item of plan.files) {
      if (
        typeof item.url !== 'string' ||
        typeof item.save_path !== 'string' ||
        !Number.isSafeInteger(item.size)
      )
        return undefined
      const source = atomicHfSource(item.url)
      if (source && !plannedFile(item)) return undefined
    }
    return plan
  } catch {
    return undefined
  }
}

/** Persist no headers, tokens or proxy credentials; current settings are applied by the executor. */
export function saveAtomicDownloadPlan<T extends AtomicTransferItem>(
  id: string,
  plan: AtomicDownloadPlan<T>
): void {
  const files = plan.files.map((item) =>
    Object.fromEntries(
      ['url', 'save_path', 'size', 'sha256', 'source', 'purpose', 'resume_key', 'model_id']
        .filter((key) => key in item)
        .map((key) => [
          key,
          key === 'source' && item.source
            ? { repo: item.source.repo, revision: item.source.revision, path: item.source.path }
            : (item as unknown as Record<string, unknown>)[key],
        ])
    )
  )
  localStorage.setItem(planKey(id), JSON.stringify({ version: 1, files }))
}

/** Resume cannot silently re-resolve main. A new task must be explicitly started for old jobs. */
export async function atomicDownloadFiles<T extends AtomicTransferItem>(
  id: string,
  items: readonly T[],
  resume: boolean,
  options: AtomicDownloadOptions = {}
): Promise<Array<T & { source?: AtomicDownloadSource }>> {
  const stored = resume ? readAtomicDownloadPlan<T>(id) : undefined
  if (stored) {
    const proxy = (items[0] as T & { proxy?: unknown })?.proxy
    return stored.files.map((file) => ({ ...file, ...(proxy ? { proxy } : {}) }))
  }
  if (!items.some((item) => atomicHfSource(item.url))) return [...items]
  // A higher-level saved request (e.g. a multi-repository diffusion model)
  // already contains the complete metadata. Its executor may send a subset
  // while another task owns a shared file; do not re-resolve that subset.
  if (items.every(plannedFile)) {
    const plan: AtomicDownloadPlan<T> = { version: 1, files: items.map((item) => ({ ...item })) }
    options.signal?.throwIfAborted()
    saveAtomicDownloadPlan(id, plan)
    return plan.files
  }
  if (
    resume &&
    items.some((item) => {
      const source = atomicHfSource(item.url)
      return source && !ATOMIC_COMMIT_RE.test(source.revision)
    })
  )
    throw new Error(
      'This download has no recorded model commit. Start a new download; partial files were kept.'
    )
  const plan = await prepareAtomicDownload(items, options)
  options.signal?.throwIfAborted()
  saveAtomicDownloadPlan(id, plan)
  return plan.files
}
