import { MCPTool, RAG_INTERNAL_SERVER } from '@janhq/core'
import { clampTopK, MAX_QUERIES, MAX_TOP_K } from './retrieval'

// Tool names
export const RETRIEVE = 'retrieve'
export const LIST_ATTACHMENTS = 'list_attachments'
export const GET_CHUNKS = 'get_chunks'

export function getRAGTools(retrievalLimit: number): MCPTool[] {
  // The setting is only the default; the ceiling stays MAX_TOP_K.
  const defaultTopK = clampTopK(undefined, retrievalLimit)

  return [
    {
      name: LIST_ATTACHMENTS,
      description:
        'List the files attached to this chat, or to its project when the chat belongs to one.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      server: RAG_INTERNAL_SERVER,
    },
    {
      name: RETRIEVE,
      description:
        'Retrieve relevant passages from the documents attached to this chat or its project. Pass search queries, never raw document content. ' +
        'When the question asks for several facts, pass one short, focused query per distinct fact in `queries` ' +
        '(for example ["capability probe timeout UTC time", "MiniLM vector dimension"]) instead of one combined query. ' +
        'Each passage has a `cite` label such as "[FINDINGS.md §13]": cite a passage by copying its `cite` label exactly. ' +
        'Never cite file ids or passage ids. Use file_ids to search within specific files only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'One search query. Use `queries` instead when the question asks for more than one fact.',
          },
          queries: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_QUERIES,
            description: `Up to ${MAX_QUERIES} short search queries, one per distinct fact asked for. Their results are merged and deduplicated.`,
          },
          top_k: {
            type: 'number',
            description: 'Optional: maximum passages to return in total.',
            minimum: 1,
            maximum: MAX_TOP_K,
            default: defaultTopK,
          },
          file_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional: Filter search to specific file IDs from list_attachments',
          },
        },
        // One of `query` / `queries` is required; retrieve() checks it so
        // the schema stays a flat object without anyOf.
        required: [],
      },
      server: RAG_INTERNAL_SERVER,
    },
    {
      name: GET_CHUNKS,
      description:
        'Retrieve chunks from a file by their order range. For a single chunk, use start_order = end_order. Use sparingly; intended for advanced usage. Prefer using retrieve instead for relevance-based fetching.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: {
            type: 'string',
            description: 'File ID from list_attachments',
          },
          start_order: {
            type: 'number',
            description: 'Start of chunk range (inclusive, 0-indexed)',
          },
          end_order: {
            type: 'number',
            description:
              'End of chunk range (inclusive, 0-indexed). For single chunk, use start_order = end_order.',
          },
        },
        required: ['file_id', 'start_order', 'end_order'],
      },
      server: RAG_INTERNAL_SERVER,
    },
  ]
}
