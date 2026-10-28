import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import { convertThreadMessagesToUIMessages } from './messages'
import { TOOL_OUTPUT_LIMIT, threadToMarkdown } from './thread-markdown'

const AT = new Date('2026-10-28T15:04:05Z')

const message = (role: string, parts: unknown[]): UIMessage =>
  ({ id: `${role}-${parts.length}`, role, parts }) as unknown as UIMessage

describe('threadToMarkdown', () => {
  it('writes the title, the export time in UTC and each message under its role', () => {
    const markdown = threadToMarkdown(
      'Trip plan',
      [
        message('user', [{ type: 'text', text: 'Where should I go?' }]),
        message('assistant', [
          { type: 'text', text: 'Lisbon.\n\n```py\nprint(1)\n```' },
        ]),
      ],
      AT
    )
    expect(markdown).toBe(
      [
        '# Trip plan',
        '_Exported from Atomic Chat on 2026-10-28 15:04 UTC_',
        '## User',
        'Where should I go?',
        '## Assistant',
        'Lisbon.\n\n```py\nprint(1)\n```',
      ].join('\n\n') + '\n'
    )
  })

  it('folds reasoning and tool results, and keeps tool errors visible', () => {
    const markdown = threadToMarkdown(
      'T',
      [
        message('assistant', [
          { type: 'reasoning', text: 'Think first.' },
          {
            type: 'tool-web_search_exa',
            state: 'output-available',
            input: { query: 'lisbon weather' },
            output: [{ type: 'text', text: 'Sunny, 22 °C' }],
          },
          {
            type: 'tool-web_fetch_exa',
            state: 'output-error',
            input: { url: 'https://example.com' },
            errorText: 'timeout',
          },
          { type: 'text', text: 'It is sunny.' },
        ]),
      ],
      AT
    )
    expect(markdown).toContain(
      '<details>\n<summary>Reasoning</summary>\n\nThink first.\n\n</details>'
    )
    expect(markdown).toContain(
      '**Tool call:** `web_search_exa`\n\n```json\n{\n  "query": "lisbon weather"\n}\n```'
    )
    expect(markdown).toContain(
      '<summary>Result</summary>\n\n```\nSunny, 22 °C\n```'
    )
    expect(markdown).toContain('**Tool call:** `web_fetch_exa`')
    expect(markdown).toContain('Error: timeout')
    expect(markdown.indexOf('Think first.')).toBeLessThan(
      markdown.indexOf('It is sunny.')
    )
  })

  it('cuts long tool results and fences ones that contain backticks', () => {
    const long = threadToMarkdown(
      'T',
      [
        message('assistant', [
          {
            type: 'tool-read',
            state: 'output-available',
            output: 'x'.repeat(TOOL_OUTPUT_LIMIT + 50),
          },
        ]),
      ],
      AT
    )
    expect(long).toContain(`${'x'.repeat(TOOL_OUTPUT_LIMIT)}\n… (truncated)`)
    expect(long).not.toContain('x'.repeat(TOOL_OUTPUT_LIMIT + 1))

    const ticks = threadToMarkdown(
      'T',
      [
        message('assistant', [
          { type: 'tool-read', state: 'output-available', output: 'a ``` b' },
        ]),
      ],
      AT
    )
    expect(ticks).toContain('````\na ``` b\n````')
  })

  it('names inline image data instead of embedding it, and links files on disk', () => {
    const markdown = threadToMarkdown(
      'T',
      [
        message('user', [
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'data:image/png;base64,iVBORw0KGgo=',
          },
          {
            type: 'file',
            filename: 'report final.pdf',
            mediaType: 'application/pdf',
            url: '/Users/me/report final.pdf',
          },
          {
            type: 'file',
            filename: 'cat.jpg',
            mediaType: 'image/jpeg',
            url: '/Users/me/cat.jpg',
          },
        ]),
      ],
      AT
    )
    expect(markdown).toContain('_Attached: image/png_')
    expect(markdown).not.toContain('base64')
    expect(markdown).toContain(
      '[report final.pdf](</Users/me/report final.pdf>)'
    )
    expect(markdown).toContain('![cat.jpg](</Users/me/cat.jpg>)')
  })

  it('skips messages with nothing to show', () => {
    const markdown = threadToMarkdown(
      'T',
      [
        message('assistant', [
          { type: 'text', text: '   ' },
          { type: 'step-start' },
        ]),
        message('user', [{ type: 'text', text: 'hi' }]),
      ],
      AT
    )
    expect(markdown).not.toContain('## Assistant')
    expect(markdown).toContain('## User\n\nhi')
  })

  it('exports a stored chat through the same conversion the chat view uses', () => {
    const stored = [
      {
        id: 'm1',
        object: 'thread.message',
        thread_id: 't1',
        role: 'assistant',
        status: MessageStatus.Ready,
        created_at: 1,
        completed_at: 2,
        content: [
          {
            type: ContentType.Text,
            text: { value: '<think>plan</think>Answer', annotations: [] },
          },
        ],
      },
    ] as unknown as ThreadMessage[]
    const markdown = threadToMarkdown(
      'T',
      convertThreadMessagesToUIMessages(stored),
      AT
    )
    expect(markdown).toContain('<summary>Reasoning</summary>\n\nplan')
    expect(markdown).toContain('## Assistant')
    expect(markdown).toMatch(/<\/details>\n\nAnswer\n$/)
  })
})
