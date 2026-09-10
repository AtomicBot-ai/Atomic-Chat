import { describe, expect, it } from 'vitest'
import { ChatCompletionRole, ContentType, MessageStatus } from '@janhq/core'
import type { ThreadMessage } from '@janhq/core'
import type { UIMessage } from 'ai'
import { rebuildEditedContent, rebuildEditedParts } from '@/lib/message-edit'
import { convertThreadMessageToUIMessage } from '@/lib/messages'

const IMAGE_URL = 'data:image/png;base64,aGVsbG8='
const SECOND_IMAGE_URL = 'data:image/jpeg;base64,d29ybGQ='
const AUDIO_URL = 'data:audio/wav;base64,YXVkaW8='

const text = (value: string) => ({
  type: ContentType.Text,
  text: { value, annotations: [] },
})
const image = (url: string) => ({
  type: ContentType.Image,
  image_url: { url, detail: 'auto' },
})

describe('rebuildEditedContent', () => {
  it('replaces the text and keeps the image', () => {
    const rebuilt = rebuildEditedContent(
      [text('what is this?'), image(IMAGE_URL)],
      'what is in this picture?'
    )

    expect(rebuilt).toHaveLength(2)
    expect(rebuilt[0]).toEqual({
      type: ContentType.Text,
      text: { value: 'what is in this picture?', annotations: [] },
    })
    expect(rebuilt[1]).toEqual(image(IMAGE_URL))
  })

  it('keeps several images in their original order', () => {
    const rebuilt = rebuildEditedContent(
      [text('compare these'), image(IMAGE_URL), image(SECOND_IMAGE_URL)],
      'which is sharper?'
    )

    expect(rebuilt.map((entry) => entry.image_url?.url)).toEqual([
      undefined,
      IMAGE_URL,
      SECOND_IMAGE_URL,
    ])
  })

  it('drops model-generated reasoning and tool calls', () => {
    // They describe the answer the edit just replaced. Re-appending them would
    // also render reasoning *below* the reply it supposedly preceded.
    const rebuilt = rebuildEditedContent(
      [
        { type: ContentType.Reasoning, text: { value: 'hmm', annotations: [] } },
        text('the answer is 4'),
        {
          type: ContentType.ToolCall,
          tool_call_id: 'call_1',
          tool_name: 'calc',
          input: { a: 2 },
          output: 4,
        },
      ],
      'the answer is 5'
    )

    expect(rebuilt).toEqual([text('the answer is 5')])
  })

  it('collapses a text-only message to a single entry', () => {
    expect(rebuildEditedContent([text('hello')], 'goodbye')).toEqual([
      text('goodbye'),
    ])
  })

  it('tolerates a missing content array', () => {
    expect(rebuildEditedContent(undefined, 'hello')).toEqual([text('hello')])
  })

  it('leaves the rebuilt record loadable, image intact', () => {
    const message = {
      id: 'm1',
      thread_id: 't1',
      role: ChatCompletionRole.User,
      status: MessageStatus.Ready,
      created_at: 0,
      completed_at: 0,
      object: 'thread.message',
      type: 'text',
      content: rebuildEditedContent(
        [text('what is this?'), image(IMAGE_URL)],
        'what is in this picture?'
      ),
    } as unknown as ThreadMessage

    const converted = convertThreadMessageToUIMessage(message)

    expect(converted.parts).toContainEqual({
      type: 'text',
      text: 'what is in this picture?',
    })
    expect(converted.parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      url: IMAGE_URL,
    })
  })
})

describe('rebuildEditedParts', () => {
  const parts = [
    { type: 'text', text: 'what is this?' },
    { type: 'file', mediaType: 'image/png', url: IMAGE_URL },
    { type: 'file', mediaType: 'audio/wav', url: AUDIO_URL },
  ] as unknown as UIMessage['parts']

  it('replaces the text and keeps image and audio parts', () => {
    const rebuilt = rebuildEditedParts(parts, 'what is in this picture?')

    expect(rebuilt).toEqual([
      { type: 'text', text: 'what is in this picture?' },
      { type: 'file', mediaType: 'image/png', url: IMAGE_URL },
      { type: 'file', mediaType: 'audio/wav', url: AUDIO_URL },
    ])
  })

  it('drops document file parts', () => {
    // A reloaded thread carries documents as `application/pdf` parts pointing
    // at a filesystem path, and any non-image file part reaching an
    // OpenAI-compatible provider throws. The document itself survives in the
    // message text and in `metadata.file_attachments`.
    const withDocument = [
      { type: 'text', text: 'summarise this' },
      {
        type: 'file',
        filename: 'report.pdf',
        mediaType: 'application/pdf',
        url: '/tmp/report.pdf',
      },
    ] as unknown as UIMessage['parts']

    expect(rebuildEditedParts(withDocument, 'summarise page 2')).toEqual([
      { type: 'text', text: 'summarise page 2' },
    ])
  })

  it('drops reasoning and tool parts', () => {
    const assistantParts = [
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'the answer is 4' },
      { type: 'tool-calc', toolCallId: 'call_1', state: 'output-available' },
    ] as unknown as UIMessage['parts']

    expect(rebuildEditedParts(assistantParts, 'the answer is 5')).toEqual([
      { type: 'text', text: 'the answer is 5' },
    ])
  })

  it('collapses several text parts into one', () => {
    const multiText = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ] as unknown as UIMessage['parts']

    expect(rebuildEditedParts(multiText, 'merged')).toEqual([
      { type: 'text', text: 'merged' },
    ])
  })

  it('tolerates a missing parts array', () => {
    expect(rebuildEditedParts(undefined, 'hello')).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })
})
