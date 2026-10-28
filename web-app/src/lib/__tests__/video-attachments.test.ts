import { describe, expect, it } from 'vitest'

import { newUserThreadContent, VIDEO_ATTACHMENT_NOTE } from '../completion'
import { processAttachmentsForSend } from '../attachmentProcessing'
import { extractFilesFromPrompt } from '../fileMetadata'
import { convertThreadMessageToUIMessage } from '../messages'
import { createMockServiceHub } from '@/test/service-hub'
import { createVideoAttachment } from '@/types/attachment'

const clip = createVideoAttachment({
  name: 'demo.mp4',
  path: '/Users/me/Movies/demo.mp4',
  fileType: 'mp4',
  mimeType: 'video/mp4',
  size: 4_000_000,
})

/**
 * No chat model takes video: an attached clip is shown to the user, and the
 * model is only told its name.
 */
describe('video attachments', () => {
  it('pass through processing untouched', async () => {
    const { processedAttachments, hasEmbeddedDocuments } =
      await processAttachmentsForSend({
        attachments: [clip],
        threadId: 't1',
        // Any call into a service would throw on the empty mock.
        serviceHub: createMockServiceHub(),
        parsePreference: 'auto',
      })

    expect(processedAttachments).toEqual([
      { ...clip, processing: false, processed: true },
    ])
    expect(hasEmbeddedDocuments).toBe(false)
  })

  it('reach the model as a name and a note, not as content', () => {
    const message = newUserThreadContent('t1', 'What is in it?', [clip])
    const text = message.content[0].text?.value ?? ''

    const { files, cleanPrompt } = extractFilesFromPrompt(text)
    expect(cleanPrompt).toBe('What is in it?')
    expect(files).toEqual([
      { id: 'demo.mp4', name: 'demo.mp4', type: 'mp4', size: 4_000_000 },
    ])
    expect(message.content).toHaveLength(1)
    expect(message.metadata?.inline_file_contents).toEqual([
      { name: 'demo.mp4', content: VIDEO_ATTACHMENT_NOTE },
    ])
  })

  it('keep their path for the preview, and never become a file part', () => {
    const message = newUserThreadContent('t1', 'Look', [clip])

    expect(message.metadata?.file_attachments).toEqual([
      {
        name: 'demo.mp4',
        path: '/Users/me/Movies/demo.mp4',
        size: 4_000_000,
        fileType: 'mp4',
        kind: 'video',
      },
    ])
    const ui = convertThreadMessageToUIMessage(message)
    expect(ui?.parts.some((part) => part.type === 'file')).toBe(false)
  })
})
