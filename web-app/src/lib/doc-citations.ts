/**
 * Readable document citations (ATO-551).
 *
 * The chat `retrieve` tool and the Agent's `docs.retrieve` label every
 * passage `[FINDINGS.md §13]` and keep its file id and passage order beside
 * the label. This module collects those tool outputs from a message's parts
 * and turns the labels the model copied into its answer into
 * `https://atomic.local/doc-cite` links, which MessageItem renders as citation
 * chips. Answers written before the labels existed cite raw chunk or file
 * UUIDs instead; the ones that match a stored output are linked too.
 * Code spans, code blocks and existing links are left alone.
 */

const DOC_CITE_PREFIX = 'https://atomic.local/doc-cite?ref='
const RETRIEVE_PARTS = new Set(['tool-retrieve', 'tool-docs.retrieve'])
const CODE_OR_LINK = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]+\))/g
// `[FINDINGS.md §13]` or `[FINDINGS.md §13, §14]`, or a bare UUID.
const LABEL_OR_UUID =
  /\[([^[\]\n§]+?)\s*((?:§\s*\d+\s*[,;]?\s*)+)\](?!\()|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

export type DocCitation = {
  /** `${fileId}:${order}`; what a doc-cite link refers to. */
  key: string
  fileId: string
  /** 0-based passage order in the file, as stored. */
  order: number
  /** 1-based passage number, as shown in the label. */
  passage: number
  /** File name; absent for outputs from before readable labels. */
  source?: string
  /** The file was no longer in its collection when the tool ran. */
  removed: boolean
  /** The passage the answer was based on. */
  text: string
  path?: string
  /** How many passages the file has. */
  passages?: number
  scope?: 'thread' | 'project'
  /** The collection's owner, when the output names it (chat outputs do). */
  threadId?: string
  projectId?: string
}

export type DocCitationIndex = {
  byKey: Map<string, DocCitation>
  byLabel: Map<string, string>
  byChunkId: Map<string, string>
  byFileId: Map<string, string>
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

const asScope = (value: unknown): DocCitation['scope'] =>
  value === 'thread' || value === 'project' ? value : undefined

const labelKey = (name: string, passage: number) =>
  `${name.trim().replace(/\s+/g, ' ').toLowerCase()} §${passage}`

/** Chat outputs are MCP content items; Agent outcomes carry a summary. */
function outputTexts(output: unknown): string[] {
  if (typeof output === 'string') return [output]
  if (Array.isArray(output)) return output.flatMap(outputTexts)
  if (!isRecord(output)) return []
  if (typeof output.text === 'string') return [output.text]
  if (typeof output.summary === 'string') return [output.summary]
  if (Array.isArray(output.content)) return outputTexts(output.content)
  return []
}

function retrievePayloads(parts: readonly unknown[]): JsonRecord[] {
  const payloads: JsonRecord[] = []
  for (const part of parts) {
    if (!isRecord(part) || !RETRIEVE_PARTS.has(String(part.type))) continue
    for (const text of outputTexts(part.output)) {
      try {
        const payload = JSON.parse(text)
        if (isRecord(payload) && Array.isArray(payload.citations)) {
          payloads.push(payload)
        }
      } catch {
        // Errors and truncated outputs are not citations.
      }
    }
  }
  return payloads
}

export function emptyDocCitationIndex(): DocCitationIndex {
  return {
    byKey: new Map(),
    byLabel: new Map(),
    byChunkId: new Map(),
    byFileId: new Map(),
  }
}

/** Every passage the message's retrieve calls returned, best first per call. */
export function collectDocCitations(
  parts: readonly unknown[]
): DocCitationIndex {
  const index = emptyDocCitationIndex()
  for (const payload of retrievePayloads(parts)) {
    const sources = new Map<string, JsonRecord>()
    for (const source of Array.isArray(payload.sources)
      ? payload.sources
      : []) {
      if (isRecord(source) && typeof source.file_id === 'string') {
        sources.set(source.file_id, source)
      }
    }

    for (const entry of payload.citations as unknown[]) {
      if (!isRecord(entry)) continue
      const fileId = asString(entry.file_id)
      const order = entry.chunk_file_order
      if (!fileId || typeof order !== 'number' || !Number.isInteger(order)) {
        continue
      }
      const key = `${fileId}:${order}`
      const stored = sources.get(fileId)
      const scope = asScope(entry.scope) ?? asScope(payload.scope)
      const citation: DocCitation = {
        key,
        fileId,
        order,
        passage: typeof entry.passage === 'number' ? entry.passage : order + 1,
        source: asString(entry.source) ?? asString(stored?.name),
        removed: entry.removed === true,
        text: typeof entry.text === 'string' ? entry.text : '',
        path: asString(stored?.path),
        passages:
          typeof stored?.passages === 'number' ? stored.passages : undefined,
        scope,
        ...(scope === 'project' && asString(payload.project_id)
          ? { projectId: String(payload.project_id) }
          : {}),
        ...(scope === 'thread' && asString(payload.thread_id)
          ? { threadId: String(payload.thread_id) }
          : {}),
      }

      const existing = index.byKey.get(key)
      if (!existing || (!existing.source && citation.source)) {
        index.byKey.set(key, citation)
      }
      if (citation.source) {
        index.byLabel.set(labelKey(citation.source, citation.passage), key)
      }
      const cite = asString(entry.cite)?.match(/^\[(.+)\s*§\s*(\d+)\]$/)
      if (cite) index.byLabel.set(labelKey(cite[1], Number(cite[2])), key)
      const chunkId = asString(entry.id)
      if (chunkId) index.byChunkId.set(chunkId.toLowerCase(), key)
      if (!index.byFileId.has(fileId.toLowerCase())) {
        index.byFileId.set(fileId.toLowerCase(), key)
      }
    }
  }
  return index
}

export function docCitationHref(key: string): string {
  return `${DOC_CITE_PREFIX}${encodeURIComponent(key)}`
}

export function docCitationKeyFromHref(href: string): string | null {
  try {
    const url = new URL(href)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'atomic.local' ||
      url.pathname !== '/doc-cite' ||
      url.searchParams.getAll('ref').length !== 1
    ) {
      return null
    }
    return url.searchParams.get('ref') || null
  } catch {
    return null
  }
}

/**
 * Links the citation labels and known UUIDs in `content`. A label nothing
 * retrieved (the model made it up or mistyped it) stays plain text.
 * `fallbackName` names a legacy citation whose output had no file name.
 */
export function linkDocCitations(
  content: string,
  index: DocCitationIndex,
  fallbackName: string
): string {
  if (index.byKey.size === 0) return content

  const link = (key: string, text: string) =>
    `[${text}](${docCitationHref(key)})`

  return content
    .split(CODE_OR_LINK)
    .map((segment, position) => {
      if (position % 2 === 1) return segment
      return segment.replace(
        LABEL_OR_UUID,
        (match, name: string | undefined, numbers: string | undefined) => {
          if (name === undefined || numbers === undefined) {
            const key =
              index.byChunkId.get(match.toLowerCase()) ??
              index.byFileId.get(match.toLowerCase())
            const citation = key ? index.byKey.get(key) : undefined
            if (!key || !citation) return match
            return link(
              key,
              `${citation.source ?? fallbackName} §${citation.passage}`
            )
          }

          const label = name.trim()
          const passages = [...numbers.matchAll(/\d+/g)].map((m) =>
            Number(m[0])
          )
          const keys = passages.map((passage) =>
            index.byLabel.get(labelKey(label, passage))
          )
          if (keys.every((key) => !key)) return match
          return passages
            .map((passage, i) => {
              const key = keys[i]
              return key
                ? link(key, `${label} §${passage}`)
                : `${label} §${passage}`
            })
            .join(', ')
        }
      )
    })
    .join('')
}
