import type { AttachmentFileInfo, VectorSearchResult } from '@janhq/core'

// The tool's ceilings are fixed rather than taken from the retrieval_limit
// setting: settings saved by older builds still say 3, and a question that
// asks for several facts needs room for one passage per fact.
export const MAX_TOP_K = 10
export const MAX_QUERIES = 5
export const DEFAULT_TOP_K = 5

// Shown in place of a file name when the hit's file is no longer listed.
export const REMOVED_SOURCE = 'removed document'
// Shown when the file listing itself could not be read.
export const UNKNOWN_SOURCE = 'document'

export type MergedHit = VectorSearchResult & {
  score: number
  matched: string[]
}

export type Citation = {
  cite: string
  source: string
  passage: number
  text: string
  score: number
  file_id: string
  chunk_file_order: number
  removed?: true
  matched?: string[]
}

export type CitedSource = {
  file_id: string
  name: string
  path?: string
  passages: number
}

/** `query` and `queries` combined: trimmed, deduplicated, at most five. */
export function collectQueries(query: unknown, queries: unknown): string[] {
  let list = queries
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = [list]
    }
  }
  const candidates = [query, ...(Array.isArray(list) ? list : [])]
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length === MAX_QUERIES) break
  }
  return out
}

export function clampTopK(requested: unknown, fallback: number): number {
  const value = Number(requested) || Number(fallback) || DEFAULT_TOP_K
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(value)))
}

const hitKey = (hit: VectorSearchResult) =>
  hit.id || `${hit.file_id}:${hit.chunk_file_order}`

/**
 * One list of passages from the per-query results (each sorted best first).
 * A passage found by several queries appears once, with its best score and
 * every query that found it. Each query's best passage is kept before the
 * rest compete on score, so one strongly matching fact cannot crowd the
 * others out of `topK`.
 */
export function mergeHits(
  queries: string[],
  perQuery: VectorSearchResult[][],
  topK: number
): MergedHit[] {
  const byChunk = new Map<string, MergedHit>()
  perQuery.forEach((hits, index) => {
    for (const hit of hits) {
      const score = hit.score ?? 0
      const existing = byChunk.get(hitKey(hit))
      if (!existing) {
        byChunk.set(hitKey(hit), { ...hit, score, matched: [queries[index]] })
        continue
      }
      if (!existing.matched.includes(queries[index])) {
        existing.matched.push(queries[index])
      }
      existing.score = Math.max(existing.score, score)
    }
  })

  const picked = new Set<MergedHit>()
  for (const hits of perQuery) {
    const best = hits[0] && byChunk.get(hitKey(hits[0]))
    if (best && picked.size < topK) picked.add(best)
  }
  const ranked = [...byChunk.values()].sort((a, b) => b.score - a.score)
  for (const hit of ranked) {
    if (picked.size >= topK) break
    picked.add(hit)
  }
  return ranked.filter((hit) => picked.has(hit))
}

const basename = (path?: string) => path?.split(/[\\/]/).pop() || undefined

export type FileFilter = {
  /** Ids to search within; undefined searches every file in the scope. */
  fileIds?: string[]
  /** Requested entries that matched no listed file. */
  unmatched: string[]
}

/**
 * The `file_ids` argument in terms of the scope's files. Models pass file
 * names as often as ids (`["FINDINGS.md"]`), and an id the store does not
 * know filters every passage out, so each entry matches a listed file by id,
 * then by name or path basename, ignoring case. When nothing matches, the
 * filter is dropped rather than returning no passages. `files` is the scope's
 * listing; without one (`null`) the entries are used as given.
 */
export function resolveFileFilter(
  requested: unknown,
  files: AttachmentFileInfo[] | null
): FileFilter {
  let list = requested
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = [list]
    }
  }
  const entries = (Array.isArray(list) ? list : [list])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) return { unmatched: [] }
  if (!files) return { fileIds: entries, unmatched: [] }

  const fileIds = new Set<string>()
  const unmatched: string[] = []
  for (const entry of entries) {
    const key = entry.toLowerCase()
    const byId = files.filter((file) => file.id === entry)
    const matches = byId.length
      ? byId
      : files.filter(
          (file) =>
            file.name?.toLowerCase() === key ||
            basename(file.path)?.toLowerCase() === key
        )
    if (matches.length === 0) unmatched.push(entry)
    for (const file of matches) fileIds.add(file.id)
  }
  return { fileIds: fileIds.size ? [...fileIds] : undefined, unmatched }
}

/** What the model is told about `file_ids` entries that matched no file. */
export function fileFilterNote(filter: FileFilter): string | undefined {
  if (filter.unmatched.length === 0) return undefined
  const listed = JSON.stringify(filter.unmatched)
  return filter.fileIds
    ? `file_ids ${listed} matched no attached document and were ignored.`
    : `file_ids ${listed} matched no attached document, so every document was searched. ` +
        'Pass file ids or file names from list_attachments to narrow the search.'
}

/**
 * Readable citations for the model to copy: `[FINDINGS.md §13]` names the
 * file and the 1-based passage, never the chunk or file ids. `files` is the
 * scope's listing, or `null` when it could not be read.
 */
export function buildCitations(
  hits: MergedHit[],
  files: AttachmentFileInfo[] | null,
  withMatched: boolean
): { citations: Citation[]; sources: CitedSource[] } {
  const listed = new Map((files ?? []).map((file) => [file.id, file]))
  const sources = new Map<string, CitedSource>()
  const citations = hits.map((hit) => {
    const file = listed.get(hit.file_id)
    const name = file
      ? file.name || basename(file.path) || UNKNOWN_SOURCE
      : files
        ? REMOVED_SOURCE
        : UNKNOWN_SOURCE
    if (file && !sources.has(file.id)) {
      sources.set(file.id, {
        file_id: file.id,
        name,
        ...(file.path ? { path: file.path } : {}),
        passages: file.chunk_count,
      })
    }
    const passage = hit.chunk_file_order + 1
    // Brackets in a file name would end the label early.
    const label = name.replace(/\[/g, '(').replace(/\]/g, ')')
    const citation: Citation = {
      cite: `[${label} §${passage}]`,
      source: name,
      passage,
      text: hit.text,
      score: hit.score,
      file_id: hit.file_id,
      chunk_file_order: hit.chunk_file_order,
    }
    if (files && !file) citation.removed = true
    if (withMatched) citation.matched = hit.matched
    return citation
  })
  return { citations, sources: [...sources.values()] }
}
