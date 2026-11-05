// Qualcomm's release manifest indexes all models. Only the per-model asset list pairs a runtime
// with a chipset. Its versioned ZIP has a full-object S3 checksum, including for multipart objects.
const ROOT = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models'
const VERSION = 'https://pypi.org/pypi/qai-hub-models/json'
const RUNTIME = 'RUNTIME_GENIEX_QAIRT'
type Chip = 'x-elite' | 'x2-elite'
interface Entry {
  id: string
  display_name: string
  manifest_urls?: { release_assets?: string }
  supported_chipsets?: string[]
  supported_runtimes?: string[]
  use_case?: string
}
interface Release {
  version: string
  models: Entry[]
}
interface Asset {
  runtime: string
  chipset: string
  precision: string
  download_url: string
}

export type QualcommBundle = { url: string; size: number; crc64: string }
export interface QualcommModel {
  id: string
  name: string
  variants: { id: string; chip: Chip; precision: string; bundle: QualcommBundle }[]
}

// Releases of the same model use the same asset filename for a given runtime, precision and chip.
// Prefer Atomic's reviewed copy even when Qualcomm has since published a new release.
const bundleKey = (url: string) =>
  url.split('?')[0]!.replace(/\/releases\/v\d+\.\d+\.\d+\//, '/releases/')

// Both clients keep successful reads for one hour. An outage is retried on the next search.
export function qualcommSearch(request: typeof fetch) {
  const cache = new Map<string, { expires: number; read: Promise<unknown> }>()
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const old = cache.get(key)
    if (old && old.expires > now) return old.read as Promise<T>
    for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k)
    const read = load().catch((error) => {
      if (cache.get(key)?.read === read) cache.delete(key)
      throw error
    })
    cache.set(key, { expires: now + 3600000, read })
    return read
  }
  async function response(url: string, init: RequestInit = {}) {
    const res = await request(url, { redirect: 'error', signal: AbortSignal.timeout(15000), ...init })
    if (!res.ok) throw new Error('Qualcomm AI Hub catalog request failed (HTTP ' + res.status + ').')
    return res
  }
  const release = () =>
    cached('manifest', async () => {
      const version: unknown = (
        (await (await response(VERSION)).json()) as { info?: { version?: unknown } }
      ).info?.version
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error('Invalid Qualcomm release.')
      const manifest = (await (
        await response(ROOT + '/releases/v' + version + '/manifest.json')
      ).json()) as Release
      if (manifest.version !== version || !Array.isArray(manifest.models))
        throw new Error('Invalid Qualcomm manifest.')
      return manifest
    })
  async function model(entry: Entry, version: string, chip: Chip, excluded: ReadonlySet<string>) {
    const base = ROOT + '/models/' + entry.id + '/releases/v' + version + '/'
    const listing = await cached(base, async () => {
      const result = (await (await response(base + 'release-assets.json')).json()) as {
        model_id: string
        aihm_version: string
        assets: Asset[]
      }
      if (
        result.model_id !== entry.id ||
        result.aihm_version !== version ||
        !Array.isArray(result.assets)
      )
        throw new Error('Invalid Qualcomm release assets.')
      return result.assets
    })
    const id = 'qai-' + entry.id
    const variants: QualcommModel['variants'] = []
    for (const a of listing) {
      if (
        a.runtime !== RUNTIME ||
        a.chipset !== 'qualcomm-snapdragon-' + chip ||
        !/^PRECISION_[A-Z0-9_]+$/.test(a.precision)
      )
        continue
      if (
        typeof a.download_url !== 'string' ||
        excluded.has(bundleKey(a.download_url)) ||
        !a.download_url.startsWith(base) ||
        !/^[a-zA-Z0-9_-][\w.-]*\.zip$/.test(a.download_url.slice(base.length))
      )
        continue
      const precision = a.precision.slice('PRECISION_'.length).toLowerCase()
      const bundle = await cached(a.download_url, async () => {
        const { headers } = await response(a.download_url, {
          method: 'HEAD',
          headers: { 'x-amz-checksum-mode': 'ENABLED' },
        })
        const crc = headers.get('x-amz-checksum-crc64nvme')
        const versionId = headers.get('x-amz-version-id')
        const size = Number(headers.get('content-length'))
        if (
          !versionId ||
          versionId === 'null' ||
          headers.get('x-amz-checksum-type') !== 'FULL_OBJECT' ||
          !crc ||
          !/^[A-Za-z0-9+/]{11}=$/.test(crc) ||
          !Number.isSafeInteger(size) ||
          size <= 0
        )
          throw new Error('Qualcomm bundle lacks a version, size or full-object checksum.')
        const crc64 = Array.from(atob(crc), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(
          ''
        )
        return { url: a.download_url + '?versionId=' + encodeURIComponent(versionId), size, crc64 }
      })
      variants.push({ id: [id, chip, precision, version].join('-'), chip, precision, bundle })
    }
    return { id, name: entry.display_name, variants }
  }
  return async (query: string, chip: Chip, excluded: ReadonlySet<string> = new Set()) => {
    const curated = new Set(Array.from(excluded, bundleKey))
    const found: QualcommModel[] = []
    let unavailable = false
    try {
      const { models, version } = await release()
      const words = query
        .toLowerCase()
        .trim()
        .split(/[\s_-]+/)
        .filter(Boolean)
      const candidates = models.filter((m) => {
        if (
          !/^[a-z0-9][a-z0-9_]*$/.test(m.id) ||
          typeof m.display_name !== 'string' ||
          m.manifest_urls?.release_assets !==
            ROOT + '/models/' + m.id + '/releases/v' + version + '/release-assets.json' ||
          m.use_case !== 'MODEL_USE_CASE_TEXT_GENERATION' ||
          !m.supported_runtimes?.includes(RUNTIME) ||
          !m.supported_chipsets?.includes('qualcomm-snapdragon-' + chip)
        )
          return false
        const terms = ('Qualcomm AI Hub qai ' + m.id + ' ' + m.display_name).toLowerCase()
        return query.startsWith('qai-' + m.id + '-') || words.every((w) => terms.includes(w))
      })
      for (let i = 0; i < candidates.length; i += 4) {
        const results = await Promise.allSettled(
          candidates.slice(i, i + 4).map((m) => model(m, version, chip, curated))
        )
        for (const result of results) {
          if (result.status === 'rejected') {
            unavailable = true
            continue
          }
          const row = result.value
          if (row.variants.length) found.push(row)
        }
      }
    } catch {
      unavailable = true
    }
    return { models: found, unavailable }
  }
}
