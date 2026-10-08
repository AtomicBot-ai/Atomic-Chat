import { describe, expect, it } from 'vitest'
import {
  collectDocCitations,
  docCitationHref,
  docCitationKeyFromHref,
  linkDocCitations,
} from './doc-citations'

const FILE_ID = 'af1035b9-6c1e-4c39-9d0e-6f1c3b2a7e10'
const CHUNK_ID = 'efeb2156-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

// What the chat `retrieve` tool stores: MCP content with a JSON payload.
const chatRetrievePart = (payload: unknown) => ({
  type: 'tool-retrieve',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { queries: ['probe timeout', 'MiniLM dimension'] },
  output: [{ type: 'text', text: JSON.stringify(payload) }],
})

const readablePayload = {
  thread_id: 'p1',
  project_id: 'p1',
  scope: 'project',
  queries: ['probe timeout', 'MiniLM dimension'],
  citations: [
    {
      cite: '[FINDINGS.md §3]',
      source: 'FINDINGS.md',
      passage: 3,
      text: 'First capability probe timeout was logged at 06:48:48 UTC.',
      score: 0.71,
      file_id: FILE_ID,
      chunk_file_order: 2,
    },
    {
      cite: '[FINDINGS.md §7]',
      source: 'FINDINGS.md',
      passage: 7,
      text: 'The MiniLM test returned an embedding vector dimension of 384.',
      score: 0.64,
      file_id: FILE_ID,
      chunk_file_order: 6,
    },
  ],
  sources: [
    {
      file_id: FILE_ID,
      name: 'FINDINGS.md',
      path: '/Users/me/docs/FINDINGS.md',
      passages: 42,
    },
  ],
  mode: 'linear',
}

// What the tool stored before readable labels: chunk ids and no names.
const legacyPayload = {
  thread_id: 'p1',
  project_id: 'p1',
  scope: 'project',
  query: 'MiniLM vector size',
  citations: [
    {
      id: CHUNK_ID,
      text: 'The MiniLM test returned an embedding vector dimension of 384.',
      score: 0.64,
      file_id: FILE_ID,
      chunk_file_order: 12,
    },
  ],
  mode: 'auto',
}

const hrefFor = (order: number) => docCitationHref(`${FILE_ID}:${order}`)

describe('linkDocCitations', () => {
  it('links the labels the model copied from the tool output', () => {
    const index = collectDocCitations([chatRetrievePart(readablePayload)])

    const linked = linkDocCitations(
      'Timeout at 06:48:48 UTC [FINDINGS.md §3]; 384 dimensions [FINDINGS.md §7].',
      index,
      'Document'
    )

    expect(linked).toBe(
      `Timeout at 06:48:48 UTC [FINDINGS.md §3](${hrefFor(2)}); ` +
        `384 dimensions [FINDINGS.md §7](${hrefFor(6)}).`
    )
    expect(docCitationKeyFromHref(hrefFor(6))).toBe(`${FILE_ID}:6`)
    expect(index.byKey.get(`${FILE_ID}:6`)).toMatchObject({
      source: 'FINDINGS.md',
      passage: 7,
      path: '/Users/me/docs/FINDINGS.md',
      passages: 42,
      projectId: 'p1',
      removed: false,
    })
  })

  it('splits one bracket that cites several passages', () => {
    const index = collectDocCitations([chatRetrievePart(readablePayload)])

    expect(linkDocCitations('[FINDINGS.md §3, §7]', index, 'Document')).toBe(
      `[FINDINGS.md §3](${hrefFor(2)}), [FINDINGS.md §7](${hrefFor(6)})`
    )
  })

  it('maps the raw chunk and file UUIDs of older answers', () => {
    const index = collectDocCitations([chatRetrievePart(legacyPayload)])

    const linked = linkDocCitations(
      `See chunk ${CHUNK_ID} of file ${FILE_ID.toUpperCase()}.`,
      index,
      'Document'
    )

    expect(linked).toBe(
      `See chunk [Document §13](${hrefFor(12)}) of file [Document §13](${hrefFor(12)}).`
    )
  })

  it('leaves code spans, code blocks and unknown labels alone', () => {
    const index = collectDocCitations([chatRetrievePart(legacyPayload)])
    const content = [
      'Inline `[Document §13]` and `' + CHUNK_ID + '`.',
      '```',
      `chunk ${CHUNK_ID}`,
      '```',
      'Unknown [OTHER.md §2], [FINDINGS.md §99] and 11111111-2222-4333-8444-555555555555.',
    ].join('\n')

    expect(linkDocCitations(content, index, 'Document')).toBe(content)
  })

  it('reads Agent docs.retrieve outcomes and their removed flag', () => {
    const index = collectDocCitations([
      {
        type: 'tool-docs.retrieve',
        toolCallId: 'agent-run-0',
        state: 'output-available',
        input: { query: 'MiniLM dimension' },
        output: {
          status: 'ok',
          summary: JSON.stringify({
            queries: ['MiniLM dimension'],
            citations: [
              {
                cite: '[removed document §2]',
                source: 'removed document',
                passage: 2,
                text: 'Stale passage.',
                score: 0.5,
                file_id: 'gone-file',
                chunk_file_order: 1,
                scope: 'thread',
                removed: true,
              },
            ],
            sources: [],
            mode: 'linear',
          }),
        },
      },
    ])

    expect(
      linkDocCitations('Was [removed document §2].', index, 'Document')
    ).toBe(`Was [removed document §2](${docCitationHref('gone-file:1')}).`)
    expect(index.byKey.get('gone-file:1')).toMatchObject({
      removed: true,
      scope: 'thread',
      text: 'Stale passage.',
    })
  })

  it('ignores failed outputs and other tools', () => {
    const index = collectDocCitations([
      { type: 'tool-retrieve', state: 'output-error', errorText: 'boom' },
      {
        type: 'tool-retrieve',
        output: [{ type: 'text', text: 'Retrieve failed: x' }],
      },
      {
        type: 'tool-web_search_exa',
        output: [{ type: 'text', text: JSON.stringify(readablePayload) }],
      },
    ])

    expect(index.byKey.size).toBe(0)
    expect(linkDocCitations('[FINDINGS.md §3]', index, 'Document')).toBe(
      '[FINDINGS.md §3]'
    )
  })
})

describe('docCitationKeyFromHref', () => {
  it('accepts only the app-local doc-cite link', () => {
    expect(docCitationKeyFromHref(hrefFor(2))).toBe(`${FILE_ID}:2`)
    expect(
      docCitationKeyFromHref('https://example.com/doc-cite?ref=a:1')
    ).toBeNull()
    expect(
      docCitationKeyFromHref('https://atomic.local/open-file?path=%2Ftmp')
    ).toBeNull()
    expect(docCitationKeyFromHref('not a url')).toBeNull()
  })
})
