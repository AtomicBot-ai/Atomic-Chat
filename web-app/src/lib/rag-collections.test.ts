import { describe, expect, it } from 'vitest'
import { projectCollection, threadCollection } from '@/lib/rag-collections'

// These names must stay byte-identical to the vector-db extension's private
// `collectionForThread` / `collectionForProject` — the Rust agent receives
// them verbatim and opens the matching SQLite files.
describe('rag collection names', () => {
  it('prefixes thread collections with attachments_', () => {
    expect(threadCollection('thread-1')).toBe('attachments_thread-1')
  })

  it('prefixes project collections with project_', () => {
    expect(projectCollection('proj-9')).toBe('project_proj-9')
  })
})
