/**
 * Vector-collection naming, mirrored from
 * `extensions/vector-db-extension/src/index.ts` (`collectionForThread` /
 * `collectionForProject`). The extension's private helpers stay the source of
 * truth for ingestion; these exports exist for callers that must pass the
 * *final* collection name verbatim — the Rust agent's `AgentTurnRequest.rag`
 * takes names as-is and never builds them itself.
 */
export const threadCollection = (threadId: string): string =>
  `attachments_${threadId}`

export const projectCollection = (projectId: string): string =>
  `project_${projectId}`
