import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { stripUnsupportedFileParts } from '../custom-chat-transport'

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', role: 'user', parts }) as UIMessage

describe('stripUnsupportedFileParts', () => {
  it('keeps image file parts', () => {
    const parts = [
      { type: 'text', text: 'what is this?' },
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aA==' },
      { type: 'file', mediaType: 'image/jpeg', url: 'https://example.com/a.jpg' },
    ]

    expect(stripUnsupportedFileParts([message(parts)])[0].parts).toEqual(parts)
  })

  it('drops audio file parts', () => {
    // Audio is delivered out-of-band as `input_audio` at the MLX fetch layer;
    // leaving the part in place makes the converter throw.
    const stripped = stripUnsupportedFileParts([
      message([
        { type: 'text', text: 'transcribe this' },
        { type: 'file', mediaType: 'audio/wav', url: 'data:audio/wav;base64,YQ==' },
      ]),
    ])

    expect(stripped[0].parts).toEqual([
      { type: 'text', text: 'transcribe this' },
    ])
  })

  it('drops document file parts pointing at a filesystem path', () => {
    // `@ai-sdk/openai-compatible` throws `UnsupportedFunctionalityError` on any
    // non-image file part, and Anthropic — which does accept application/pdf —
    // would take the local path as the document body. The document itself
    // reaches the model as text, folded in by mapUserInlineAttachments.
    const stripped = stripUnsupportedFileParts([
      message([
        { type: 'text', text: 'summarise this' },
        {
          type: 'file',
          filename: 'report.pdf',
          mediaType: 'application/pdf',
          url: '/Users/someone/report.pdf',
        },
      ]),
    ])

    expect(stripped[0].parts).toEqual([
      { type: 'text', text: 'summarise this' },
    ])
  })

  it('drops a file part with no media type at all', () => {
    const stripped = stripUnsupportedFileParts([
      message([
        { type: 'text', text: 'hello' },
        { type: 'file', url: '/Users/someone/mystery.bin' },
      ]),
    ])

    expect(stripped[0].parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('leaves reasoning and tool parts alone', () => {
    const parts = [
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'the answer is 4' },
      { type: 'tool-calc', toolCallId: 'call_1', state: 'output-available' },
    ]

    expect(stripUnsupportedFileParts([message(parts)])[0].parts).toEqual(parts)
  })

  it('returns untouched messages by reference', () => {
    const clean = message([{ type: 'text', text: 'hello' }])
    const dirty = message([
      { type: 'file', mediaType: 'application/pdf', url: '/tmp/a.pdf' },
    ])

    const [first, second] = stripUnsupportedFileParts([clean, dirty])

    expect(first).toBe(clean)
    expect(second).not.toBe(dirty)
    // The input message is not mutated.
    expect(dirty.parts).toHaveLength(1)
  })

  it('tolerates a message with no parts array', () => {
    const broken = { id: 'm1', role: 'user' } as unknown as UIMessage
    expect(stripUnsupportedFileParts([broken])[0]).toBe(broken)
  })
})
