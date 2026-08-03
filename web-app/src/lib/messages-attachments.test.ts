import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import { describe, expect, it } from 'vitest'

import { convertThreadMessageToUIMessage } from './messages'

describe('Agent attachment history', () => {
  it('restores staged documents and images as named file parts', () => {
    const message: ThreadMessage = {
      id: 'message-1',
      object: 'thread.message',
      thread_id: 'thread-1',
      role: 'user',
      status: MessageStatus.Ready,
      created_at: 1,
      completed_at: 1,
      content: [
        {
          type: ContentType.Text,
          text: { value: 'Inspect these files', annotations: [] },
        },
        {
          type: ContentType.Image,
          image_url: {
            url: 'data:image/png;base64,aGVsbG8=',
            detail: 'auto',
          },
        },
      ],
      metadata: {
        file_attachments: [
          {
            name: 'report.pdf',
            path: '/thread/agent-attachments/turn/01.pdf',
            mediaType: 'application/pdf',
          },
        ],
      },
    }

    const converted = convertThreadMessageToUIMessage(message)

    expect(converted.parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,aGVsbG8=',
    })
    expect(converted.parts).toContainEqual({
      type: 'file',
      filename: 'report.pdf',
      mediaType: 'application/pdf',
      url: '/thread/agent-attachments/turn/01.pdf',
    })
  })
})
