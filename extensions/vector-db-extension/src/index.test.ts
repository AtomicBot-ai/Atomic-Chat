import { beforeEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({ listAttachments: undefined as unknown }))

// In-memory stand-in for the vector-db Tauri plugin so the assertions are
// about what ends up stored and what the caller gets back.
type StoredChunk = { text: string; embedding: number[] }
const store = {
  collections: new Map<string, number>(),
  files: new Map<string, Array<{ id: string; name?: string; path?: string }>>(),
  chunks: new Map<string, Map<string, StoredChunk[]>>(),
  reset() {
    this.collections.clear()
    this.files.clear()
    this.chunks.clear()
  },
}

vi.mock(
  '../../../src-tauri/plugins/tauri-plugin-vector-db/guest-js/index',
  () => ({
    createCollection: async (name: string, dimension: number) => {
      store.collections.set(name, dimension)
    },
    deleteCollection: async (name: string) => {
      store.collections.delete(name)
      store.files.delete(name)
      store.chunks.delete(name)
    },
    listAttachments: async (name: string) => {
      if (failures.listAttachments) throw failures.listAttachments
      return (store.files.get(name) ?? []).map((f) => ({
        ...f,
        chunk_count: store.chunks.get(name)?.get(f.id)?.length ?? 0,
      }))
    },
    createFile: async (name: string, file: { path: string; name?: string }) => {
      const files = store.files.get(name) ?? []
      const fi = { id: `file-${files.length + 1}`, ...file }
      files.push(fi)
      store.files.set(name, files)
      return { ...fi, chunk_count: 0 }
    },
    insertChunks: async (
      name: string,
      fileId: string,
      chunks: StoredChunk[]
    ) => {
      const perFile = store.chunks.get(name) ?? new Map()
      perFile.set(fileId, [...(perFile.get(fileId) ?? []), ...chunks])
      store.chunks.set(name, perFile)
    },
    chunkText: async (text: string) => text.split('\n\n').filter(Boolean),
  })
)

vi.mock('../../../src-tauri/plugins/tauri-plugin-rag/guest-js/index', () => ({
  parseDocument: async () => 'alpha\n\nbeta\n\ngamma',
}))

vi.mock('@janhq/core', () => ({
  VectorDBExtension: class {},
  AIEngine: class {},
}))

import VectorDBExt from './index'

const DIMENSION = 4
const vectorFor = (text: string) =>
  Array.from({ length: DIMENSION }, (_, i) => text.charCodeAt(0) + i)

// Every text the embedding engine was asked to embed, across all calls.
let embeddedTexts: string[] = []

beforeEach(() => {
  store.reset()
  embeddedTexts = []
  failures.listAttachments = undefined
  ;(globalThis as any).window.core = {
    extensionManager: {
      getByName: (name: string) =>
        name === '@janhq/llamacpp-upstream-extension'
          ? {
              embed: async (texts: string[]) => {
                embeddedTexts.push(...texts)
                return {
                  data: texts.map((t, index) => ({
                    index,
                    embedding: vectorFor(t),
                  })),
                }
              },
            }
          : undefined,
    },
  }
})

describe('ingestFileForProject', () => {
  it('embeds each chunk once and stores every chunk with its vector', async () => {
    const ext = new VectorDBExt('vector-db', '@janhq/vector-db-extension')
    const file = {
      path: '/docs/notes.md',
      name: 'notes.md',
      type: 'text/markdown',
    }

    const info = await ext.ingestFileForProject('p1', file, {
      chunkSize: 512,
      chunkOverlap: 0,
    })

    // The embedder did exactly the work of one pass over the chunks.
    expect(embeddedTexts).toEqual(['alpha', 'beta', 'gamma'])

    // What the user sees: the attachment reports all chunks, and the
    // collection was created with the model's dimension.
    expect(info.chunk_count).toBe(3)
    expect(store.collections.get('project_p1')).toBe(DIMENSION)
    expect(store.chunks.get('project_p1')?.get(info.id)).toEqual([
      { text: 'alpha', embedding: vectorFor('alpha') },
      { text: 'beta', embedding: vectorFor('beta') },
      { text: 'gamma', embedding: vectorFor('gamma') },
    ])
  })
})

describe('listAttachmentsForProject', () => {
  it('treats a new collection without a files table as empty', async () => {
    failures.listAttachments = {
      DatabaseError: 'no such table: files',
    }
    const ext = new VectorDBExt('vector-db', '@janhq/vector-db-extension')

    await expect(ext.listAttachmentsForProject('new-project')).resolves.toEqual(
      []
    )
  })

  it('keeps real database failures visible', async () => {
    failures.listAttachments = { DatabaseError: 'database is locked' }
    const ext = new VectorDBExt('vector-db', '@janhq/vector-db-extension')

    await expect(ext.listAttachmentsForProject('p1')).rejects.toEqual({
      DatabaseError: 'database is locked',
    })
  })
})
