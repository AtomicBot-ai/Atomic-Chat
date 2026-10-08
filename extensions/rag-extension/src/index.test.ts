import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@janhq/core', () => ({
  RAGExtension: class {},
  VectorDBExtension: class {},
  AIEngine: class {},
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
  RAG_INTERNAL_SERVER: 'rag-internal',
}))

vi.mock('../../../src-tauri/plugins/tauri-plugin-rag/guest-js/index', () => ({
  parseDocument: async () => '',
}))

import RagExtension from './index'
import { getRAGTools, RETRIEVE } from './tools'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const FILE_ID = 'af1035b9-6c1e-4c39-9d0e-6f1c3b2a7e10'
const DIMENSION = 64

// Deterministic bag-of-words embedding: each word lands in a hashed bucket,
// so cosine similarity rewards shared words and nothing else.
const words = (text: string) => text.toLowerCase().match(/[a-z0-9:]+/g) ?? []
function embedBagOfWords(text: string): number[] {
  const vector = new Array(DIMENSION).fill(0)
  for (const word of words(text)) {
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    vector[hash % DIMENSION] += 1
  }
  return vector
}
function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0)
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm(a) && norm(b) ? dot / (norm(a) * norm(b)) : 0
}

// FINDINGS.md: the three facts sit in separate passages between filler.
const FINDINGS = [
  'Findings of the embedding runtime evaluation on the test machine.',
  'Model downloads completed without checksum errors.',
  'First capability probe timeout was logged at 06:48:48 UTC.',
  'Disk usage stayed below the configured quota during the run.',
  'Second capability probe timeout was logged at 06:54:59 UTC.',
  'The settings page rendered every attachment option.',
  'The MiniLM test returned an embedding vector dimension of 384.',
  'Release notes were drafted for the next update.',
]

type Chunk = {
  id: string
  file_id: string
  chunk_file_order: number
  text: string
  embedding: number[]
}

const db = {
  chunks: [] as Chunk[],
  files: [] as Array<{
    id: string
    name: string
    path: string
    chunk_count: number
  }>,
  searches: [] as Array<{ limit: number; mode?: string; queryText?: string }>,
  embedCalls: [] as string[][],
}

function seedFile(fileId: string, name: string, texts: string[]) {
  texts.forEach((text, order) =>
    db.chunks.push({
      id: `${fileId.slice(0, 8)}-0000-4000-8000-${String(order).padStart(12, '0')}`,
      file_id: fileId,
      chunk_file_order: order,
      text,
      embedding: embedBagOfWords(text),
    })
  )
  db.files.push({
    id: fileId,
    name,
    path: `/Users/me/docs/${name}`,
    chunk_count: texts.length,
  })
}

const vectorDb = {
  searchCollectionForProject: async (
    _projectId: string,
    embedding: number[],
    limit: number,
    threshold: number,
    mode?: string,
    _fileIds?: string[],
    queryText?: string
  ) => {
    db.searches.push({ limit, mode, queryText })
    return db.chunks
      .map(({ embedding: stored, ...chunk }) => ({
        ...chunk,
        score: cosine(embedding, stored),
      }))
      .filter((hit) => hit.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  },
  listAttachmentsForProject: async () => db.files,
}

beforeEach(() => {
  db.chunks = []
  db.files = []
  db.searches = []
  db.embedCalls = []
  ;(globalThis as any).window.core = {
    extensionManager: {
      get: () => vectorDb,
      getByName: (name: string) =>
        name === '@janhq/llamacpp-upstream-extension'
          ? {
              embed: async (texts: string[]) => {
                db.embedCalls.push(texts)
                return {
                  data: texts.map((text, index) => ({
                    index,
                    embedding: embedBagOfWords(text),
                  })),
                }
              },
            }
          : undefined,
    },
  }
})

const newExtension = () =>
  new (RagExtension as any)('rag', '@janhq/rag-extension') as RagExtension

async function retrieve(args: Record<string, unknown>) {
  const result = await newExtension().callTool(RETRIEVE, {
    scope: 'project',
    project_id: 'p1',
    thread_id: 'p1',
    ...args,
  })
  const text = (result.content[0] as { text: string }).text
  return {
    error: result.error,
    text,
    payload: result.error ? undefined : JSON.parse(text),
  }
}

describe('retrieve', () => {
  it('finds every fact of a multi-part question with one query per fact', async () => {
    seedFile(FILE_ID, 'FINDINGS.md', FINDINGS)
    const queries = [
      'first capability probe timeout UTC time',
      'second capability probe timeout UTC time',
      'MiniLM vector dimension',
    ]

    const { payload, text } = await retrieve({ queries })

    const passages = payload.citations.map(
      (c: { passage: number }) => c.passage
    )
    expect(passages).toEqual(expect.arrayContaining([3, 5, 7]))
    expect(new Set(passages).size).toBe(passages.length)
    const facts = payload.citations
      .map((c: { text: string }) => c.text)
      .join('\n')
    expect(facts).toContain('06:48:48 UTC')
    expect(facts).toContain('06:54:59 UTC')
    expect(facts).toContain('384')
    // One embedding request for all queries; every search is linear and
    // carries its own query text for the lexical boost.
    expect(db.embedCalls).toEqual([queries])
    expect(db.searches.map((s) => [s.mode, s.queryText])).toEqual(
      queries.map((query) => ['linear', query])
    )
    // A passage both timeout queries found appears once and says so.
    const first = payload.citations.find(
      (c: { passage: number }) => c.passage === 3
    )
    expect(first.matched).toEqual(expect.arrayContaining([queries[0]]))
    expect(text).not.toContain(db.chunks[2].id)
  })

  it('merges query and queries, trims and deduplicates them', async () => {
    seedFile(FILE_ID, 'FINDINGS.md', FINDINGS)

    const { payload } = await retrieve({
      query: ' MiniLM vector dimension ',
      queries: ['minilm vector dimension', '', 'probe timeout'],
    })

    expect(payload.queries).toEqual([
      'MiniLM vector dimension',
      'probe timeout',
    ])
  })

  it('clamps top_k to 10 whatever the request asks for', async () => {
    seedFile(
      FILE_ID,
      'FINDINGS.md',
      Array.from({ length: 15 }, (_, i) => `probe log line ${i}`)
    )

    const { payload } = await retrieve({ query: 'probe log line', top_k: 99 })

    expect(payload.citations).toHaveLength(10)
    expect(db.searches.map((s) => s.limit)).toEqual([10])
  })

  it('labels citations with the file name and passage, never an id', async () => {
    seedFile(FILE_ID, 'FINDINGS.md', FINDINGS)

    const { payload } = await retrieve({ query: 'MiniLM vector dimension' })

    expect(payload.citations[0]).toMatchObject({
      cite: '[FINDINGS.md §7]',
      source: 'FINDINGS.md',
      passage: 7,
      file_id: FILE_ID,
      chunk_file_order: 6,
    })
    for (const citation of payload.citations) {
      expect(citation.cite).toMatch(/^\[FINDINGS\.md §\d+\]$/)
      expect(citation.cite).not.toMatch(UUID)
      expect(citation).not.toHaveProperty('id')
    }
    expect(payload.sources).toEqual([
      {
        file_id: FILE_ID,
        name: 'FINDINGS.md',
        path: '/Users/me/docs/FINDINGS.md',
        passages: FINDINGS.length,
      },
    ])
  })

  it('labels a passage whose file is no longer listed as removed', async () => {
    seedFile(FILE_ID, 'FINDINGS.md', FINDINGS)
    db.files = []

    const { payload } = await retrieve({ query: 'MiniLM vector dimension' })

    expect(payload.citations[0]).toMatchObject({
      cite: '[removed document §7]',
      source: 'removed document',
      removed: true,
    })
    expect(payload.sources).toEqual([])
  })

  it('asks for a query when neither query nor queries is given', async () => {
    const { error, text } = await retrieve({ queries: ['  '] })

    expect(error).toBe('Missing query')
    expect(text).toContain('queries')
  })
})

describe('retrieve tool schema', () => {
  it('offers queries and a top_k ceiling independent of the setting', () => {
    for (const limit of [3, 5, 20]) {
      const tool = getRAGTools(limit).find((t) => t.name === RETRIEVE)!
      const schema = tool.inputSchema as any

      expect(schema.properties.queries).toMatchObject({
        type: 'array',
        items: { type: 'string' },
        maxItems: 5,
      })
      expect(schema.properties.top_k.maximum).toBe(10)
      expect(schema.properties.top_k.default).toBe(Math.min(limit, 10))
      expect(schema.required).not.toContain('query')
      expect(tool.description).toContain(
        'one short, focused query per distinct fact'
      )
      expect(tool.description).toContain('copying its `cite` label exactly')
      expect(tool.description).not.toMatch(/\bscope\b/)
    }
  })
})
