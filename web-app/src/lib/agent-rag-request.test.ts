import { describe, expect, it } from 'vitest'
import { buildAgentRagRequest } from '@/lib/agent-rag-request'

describe('buildAgentRagRequest', () => {
  it('returns undefined when nothing is indexed anywhere', () => {
    expect(
      buildAgentRagRequest({
        threadId: 't1',
        projectId: 'p1',
        threadHasDocuments: false,
        projectHasFiles: false,
        embeddedAttachmentNames: [],
      })
    ).toBeUndefined()
  })

  it('builds a thread-only request from the sticky flag', () => {
    expect(
      buildAgentRagRequest({
        threadId: 't1',
        threadHasDocuments: true,
        projectHasFiles: false,
        embeddedAttachmentNames: [],
      })
    ).toEqual({
      thread_collection: 'attachments_t1',
      attached_file_names: [],
    })
  })

  it('counts freshly embedded attachments as thread documents', () => {
    expect(
      buildAgentRagRequest({
        threadId: 't1',
        threadHasDocuments: false,
        projectHasFiles: false,
        embeddedAttachmentNames: ['report.pdf'],
      })
    ).toEqual({
      thread_collection: 'attachments_t1',
      attached_file_names: ['report.pdf'],
    })
  })

  it('adds the project collection only when the project has files', () => {
    expect(
      buildAgentRagRequest({
        threadId: 't1',
        projectId: 'p1',
        threadHasDocuments: false,
        projectHasFiles: true,
        embeddedAttachmentNames: [],
      })
    ).toEqual({
      thread_collection: 'attachments_t1',
      project_collection: 'project_p1',
      attached_file_names: [],
    })
  })

  it('never names a project collection without a project id', () => {
    expect(
      buildAgentRagRequest({
        threadId: 't1',
        threadHasDocuments: true,
        projectHasFiles: true,
        embeddedAttachmentNames: [],
      })
    ).toEqual({
      thread_collection: 'attachments_t1',
      attached_file_names: [],
    })
  })
})
