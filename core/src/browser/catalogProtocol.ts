/** Browser-safe contract for the single editable Atomic Chat model catalog. */
export type AtomicCatalogRecord = Record<string, unknown>
export interface AtomicCatalogEntry {
  kind: string
  metadata?: AtomicCatalogRecord
  files?: Array<{ path: string; size: number; sha256?: string; model_id?: string }>
  format: string
  variants: Record<string, AtomicCatalogRecord>
  definition: AtomicCatalogRecord
  omit_revisions?: string[]
}
export interface AtomicCatalogCollection {
  header: AtomicCatalogRecord
  entries?: Array<{ model: string; variant: string }>
  recommendations?: AtomicCatalogRecord[]
  low_spec_recommendations?: AtomicCatalogRecord[]
  tiers?: Record<string, AtomicCatalogRecord[]>
}
export interface AtomicModelCatalog {
  schema_version: 1
  updated_at: string
  models: Record<string, AtomicCatalogEntry>
  collections: Record<string, AtomicCatalogCollection>
}
export const ATOMIC_MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/catalog.json'
export const ATOMIC_COMMIT_RE = /^[0-9a-f]{40}$/
const fields: Record<string, string> = {
  audio: 'models',
  'atomic-prism-models': 'families',
  'staff-picks': 'picks',
  'diffusion': 'families',
  'embedding': 'models',
  'decision': 'models',
  'litert-lm-models': 'models',
  'geniex-models': 'models',
  'foundry-local-models': 'models',
  'fastflowlm-models': 'models',
}
const record = (v: unknown): v is AtomicCatalogRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Reject a document that cannot supply immutable sources or valid model references. */
export function parseAtomicModelCatalog(value: unknown): AtomicModelCatalog {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    typeof value.updated_at !== 'string' ||
    !record(value.models) ||
    !record(value.collections)
  )
    throw new Error('Invalid Atomic Chat model catalog')
  const sources = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(sources)
    if (!record(v)) return
    if (
      (typeof v.repo === 'string' || typeof v.model_name === 'string') &&
      (typeof v.revision !== 'string' || !ATOMIC_COMMIT_RE.test(v.revision))
    ) {
      throw new Error(`Missing immutable revision for ${String(v.repo ?? v.model_name)}`)
    }
    Object.values(v).forEach(sources)
  }
  for (const entry of Object.values(value.models)) {
    if (
      !record(entry) ||
      typeof entry.kind !== 'string' ||
      typeof entry.format !== 'string' ||
      !record(entry.variants) ||
      !record(entry.definition)
    )
      throw new Error('Invalid catalog model')
    sources(entry.definition)
    if (entry.kind === 'chat' && (!Array.isArray(entry.files) || entry.files.length === 0))
      throw new Error('Missing catalog file plan')
    if (Array.isArray(entry.files))
      for (const file of entry.files) {
        if (
          !record(file) ||
          typeof file.path !== 'string' ||
          file.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
          !Number.isSafeInteger(file.size) ||
          (file.size as number) < 0 ||
          (file.sha256 !== undefined &&
            (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)))
        )
          throw new Error('Invalid catalog file metadata')
      }
  }
  const catalog = value as unknown as AtomicModelCatalog
  for (const name of ['recommended', ...Object.keys(fields)])
    projectAtomicModelCollection(catalog, name)
  return catalog
}

/** Adapt one collection in memory; new clients retain its per-repository pins. */
export function projectAtomicModelCollection(
  catalog: AtomicModelCatalog,
  name: string,
  pinned = true
): AtomicCatalogRecord {
  const collection = catalog.collections[name]
  if (!collection || !record(collection.header) || collection.header.schema_version !== 1)
    throw new Error(`Missing or unsupported model collection ${name}`)
  const model = (id: unknown, variant?: unknown): AtomicCatalogRecord => {
    if (typeof id !== 'string' || !catalog.models[id])
      throw new Error(`Unknown catalog model ${String(id)}`)
    const entry = catalog.models[id]
    const expectedKind =
      name === 'recommended' || name === 'staff-picks'
        ? 'chat'
        : name === 'atomic-prism-models'
          ? 'prism'
          : name.replace(/-models$/, '')
    if (entry.kind !== expectedKind) throw new Error(`Invalid model kind in ${name}`)
    if (typeof variant !== 'string' || !record(entry.variants[variant]))
      throw new Error(`Unknown catalog variant ${String(variant)} of ${id}`)
    const data = structuredClone(entry.definition)
    if (!pinned)
      for (const path of entry.omit_revisions ?? []) {
        const parts = path.split('.')
        const key = parts.pop()!
        let parent: unknown = data
        for (const part of parts)
          parent =
            parent !== null && typeof parent === 'object'
              ? (parent as AtomicCatalogRecord)[part]
              : undefined
        if (record(parent)) delete parent[key]
      }
    return data
  }
  if (name !== 'recommended') {
    if (!fields[name] || !Array.isArray(collection.entries))
      throw new Error(`Invalid model collection ${name}`)
    return {
      ...collection.header,
      [fields[name]]: collection.entries.map((ref) => model(ref.model, ref.variant)),
    }
  }
  const recommendations = (entries: AtomicCatalogRecord[]) =>
    entries.map(({ model: id, variant, projector_variant: projector, ...rest }) => {
      const data = model(id, variant)
      const variants = catalog.models[id as string]!.variants
      if (projector !== undefined) model(id, projector)
      return {
        model_name: data.model_name,
        ...(pinned ? { revision: data.revision } : {}),
        ...rest,
        ...(variants[variant as string]!.quant
          ? { quant: variants[variant as string]!.quant }
          : {}),
        ...(projector !== undefined ? { mmproj_quant: variants[projector as string]!.quant } : {}),
      }
    })
  if (!Array.isArray(collection.recommendations)) throw new Error('Missing model recommendations')
  return {
    ...collection.header,
    recommendations: recommendations(collection.recommendations),
    ...(collection.low_spec_recommendations
      ? { low_spec_recommendations: recommendations(collection.low_spec_recommendations) }
      : {}),
    ...(collection.tiers
      ? {
          tiers: Object.fromEntries(
            Object.entries(collection.tiers).map(([key, list]) => [key, recommendations(list)])
          ),
        }
      : {}),
  }
}

/** Explicit per-entry revisions take precedence; this supplies the curated default for a repository. */
export function atomicModelRevision(catalog: AtomicModelCatalog, repo: string): string | undefined {
  const chat = Object.values(catalog.models).find(
    (e) => e.kind === 'chat' && e.definition.model_name === repo
  )
  if (chat) return chat.definition.revision as string
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!record(value)) return
    if (value.repo === repo && typeof value.revision === 'string') found.add(value.revision)
    Object.values(value).forEach(visit)
  }
  Object.values(catalog.models).forEach((e) => visit(e.definition))
  if (found.size > 1) throw new Error(`Choose an explicit revision for ${repo}`)
  return [...found][0]
}
