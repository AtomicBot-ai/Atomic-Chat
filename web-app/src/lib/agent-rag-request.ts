import { projectCollection, threadCollection } from '@/lib/rag-collections'
import type { AgentRagRequest } from '@/types/agent'

/**
 * Assembles the per-turn RAG context for an agent turn, or `undefined` when
 * the thread has no indexed documents anywhere — the backend then disables
 * the `docs.*` tools and the prompt stays byte-identical to a docless turn.
 *
 * The thread collection is always named even when only the project has
 * files: a missing collection answers with empty results, and the thread can
 * gain documents mid-conversation without changing shape.
 */
export const buildAgentRagRequest = (input: {
  threadId: string
  projectId?: string
  threadHasDocuments: boolean
  projectHasFiles: boolean
  embeddedAttachmentNames: string[]
}): AgentRagRequest | undefined => {
  const hasThreadDocs =
    input.threadHasDocuments || input.embeddedAttachmentNames.length > 0
  const hasProjectDocs = Boolean(input.projectId) && input.projectHasFiles
  if (!hasThreadDocs && !hasProjectDocs) return undefined
  return {
    thread_collection: threadCollection(input.threadId),
    ...(hasProjectDocs && input.projectId
      ? { project_collection: projectCollection(input.projectId) }
      : {}),
    attached_file_names: input.embeddedAttachmentNames,
  }
}
