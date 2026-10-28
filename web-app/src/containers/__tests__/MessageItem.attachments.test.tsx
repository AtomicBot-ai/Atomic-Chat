import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'
import { injectFilesIntoPrompt } from '@/lib/fileMetadata'
import type { AttachmentPreviewSource } from '../AttachmentPreviewDialog'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (s: unknown) => unknown) =>
    selector({ disableReasoning: false }),
}))

// The dialog itself is covered in AttachmentPreviewDialog.test.tsx; here only
// what MessageItem hands it matters.
vi.mock('../AttachmentPreviewDialog', () => ({
  AttachmentPreviewDialog: ({
    source,
  }: {
    source: AttachmentPreviewSource | null
  }) =>
    source ? <div data-testid="preview">{JSON.stringify(source)}</div> : null,
}))

beforeEach(() => {
  seedServiceHub()
})

const userMessage = (metadata: Record<string, unknown>): UIMessage => ({
  id: 'u1',
  role: 'user',
  parts: [
    {
      type: 'text',
      text: injectFilesIntoPrompt('Summarize these', [
        { id: 'f1', name: 'plan.docx', type: 'docx', size: 2048 },
        { id: 'demo.mp4', name: 'demo.mp4', type: 'mp4', size: 4096 },
      ]),
    },
  ],
  metadata,
})

const renderMessage = (message: UIMessage) =>
  render(
    <MessageItem
      message={message}
      isFirstMessage
      isLastMessage={false}
      status="ready"
    />
  )

describe('MessageItem attachments', () => {
  it('opens a sent file from the path its message recorded', () => {
    renderMessage(
      userMessage({
        file_attachments: [
          {
            name: 'plan.docx',
            path: '/docs/plan.docx',
            fileType: 'docx',
            size: 2048,
          },
          {
            name: 'demo.mp4',
            path: '/movies/demo.mp4',
            fileType: 'mp4',
            size: 4096,
            kind: 'video',
          },
        ],
        inline_file_contents: [
          { name: 'plan.docx', content: 'Plan text' },
          { name: 'demo.mp4', content: 'note for the model' },
        ],
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'plan.docx' }))
    expect(JSON.parse(screen.getByTestId('preview').textContent!)).toEqual({
      name: 'plan.docx',
      path: '/docs/plan.docx',
      fileType: 'docx',
      size: 2048,
      inlineContent: 'Plan text',
    })

    fireEvent.click(screen.getByRole('button', { name: 'demo.mp4' }))
    // The note the model got is not the video's content.
    expect(JSON.parse(screen.getByTestId('preview').textContent!)).toEqual({
      name: 'demo.mp4',
      path: '/movies/demo.mp4',
      fileType: 'mp4',
      size: 4096,
    })
  })

  it('leaves chips inert when the message has no paths', () => {
    renderMessage(userMessage({}))

    expect(screen.getByText('plan.docx')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'plan.docx' })).toBeNull()
  })
})
