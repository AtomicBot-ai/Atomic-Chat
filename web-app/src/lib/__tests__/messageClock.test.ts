import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  captureMessageClock,
  messageClockLabel,
  prependStoredMessageClock,
  withMessageClocksForModel,
} from '../messageClock'
import { newUserThreadContent } from '../completion'
import { convertThreadMessagesToUIMessages } from '../messages'
import { buildAgentSessionSyncMessages } from '../agent-session-sync'

const now = new Date(2026, 9, 23, 1, 37, 56)
afterEach(() => vi.useRealTimers())
describe('separate persisted message clocks', () => {
  it.each([
    [false, false, undefined, 'hello'],
    [true, false, { date: '2026-10-23' }, '[Date: 2026-10-23]\nhello'],
    [false, true, { time: '01:37:56' }, '[Time: 01:37:56]\nhello'],
    [
      true,
      true,
      { date: '2026-10-23', time: '01:37:56' },
      '[Date: 2026-10-23 | Time: 01:37:56]\nhello',
    ],
  ])(
    'date=%s/time=%s is model-only context',
    (include_date, include_time, expected, wire) => {
      const clock = captureMessageClock({ include_date, include_time }, now)
      expect(clock).toEqual(expected)
      expect(prependStoredMessageClock('hello', { message_clock: clock })).toBe(
        wire
      )
    }
  )

  it('keeps defaults off and never parses legacy date-looking message text', () => {
    const text = '[Date: 2026-10-23 | Time: 01:37:56]\nhello'
    const message = newUserThreadContent('t', text)
    expect(message.content[0].text?.value).toBe(text)
    expect(message.metadata?.message_clock).toBeUndefined()
    expect(messageClockLabel(message.metadata)).toBeUndefined()
  })

  it('freezes metadata across midnight, reload, subsequent sends and option changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 23, 23, 59, 59))
    const options = { include_date: true, include_time: true }
    const first = newUserThreadContent('t', 'first', [], 'one', options)
    const stored = JSON.stringify(first)
    vi.setSystemTime(new Date(2026, 9, 24, 0, 0, 1))
    const restored = JSON.parse(stored)
    const second = newUserThreadContent('t', 'second', [], 'two', options)
    const ui = convertThreadMessagesToUIMessages([restored, second])
    const snapshot = JSON.stringify(ui)
    const wire = withMessageClocksForModel(ui)
    expect(first.content[0].text?.value).toBe('first')
    expect(second.content[0].text?.value).toBe('second')
    expect(messageClockLabel(restored.metadata)).toBe('2026-10-23 23:59:59')
    expect(messageClockLabel(second.metadata)).toBe('2026-10-24 00:00:01')
    expect(wire[0].parts[0]).toEqual({
      type: 'text',
      text: '[Date: 2026-10-23 | Time: 23:59:59]\nfirst',
    })
    expect(withMessageClocksForModel(ui)).toEqual(wire)
    expect(JSON.stringify(ui)).toBe(snapshot)
    expect(JSON.stringify(first)).toBe(stored)
  })

  it('preserves attachment parts and handles image-only messages and native-agent replay', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const message = newUserThreadContent(
      't',
      'inspect',
      [
        {
          id: 'doc',
          name: 'notes.txt',
          type: 'document',
          fileType: 'txt',
          injectionMode: 'inline',
          inlineContent: 'notes',
        },
        {
          name: 'picture.png',
          type: 'image',
          base64: 'AAAA',
          mimeType: 'image/png',
        },
      ],
      'one',
      { include_time: true }
    )
    expect(message.content[0].text?.value).toMatch(/^inspect/)
    expect(message.content[0].text?.value).toContain('[ATTACHED_FILES]')
    expect(message.metadata?.inline_file_contents).toEqual([
      { name: 'notes.txt', content: 'notes' },
    ])
    const ui = convertThreadMessagesToUIMessages([message])
    const wire = withMessageClocksForModel(ui)
    expect(wire[0].parts.filter((p) => p.type === 'file')).toEqual(
      ui[0].parts.filter((p) => p.type === 'file')
    )
    message.metadata = { ...message.metadata, agent_input_text: 'inspect' }
    expect(buildAgentSessionSyncMessages([message])).toEqual([
      { role: 'user', text: '[Time: 01:37:56]\ninspect' },
    ])
    const imageOnly: UIMessage = {
      id: 'image',
      role: 'user',
      metadata: message.metadata,
      parts: [
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,AAAA',
        },
      ],
    }
    expect(withMessageClocksForModel([imageOnly])[0].parts[0]).toEqual({
      type: 'text',
      text: '[Time: 01:37:56]\n',
    })
  })

  it('ignores malformed metadata and clocks on assistant messages', () => {
    expect(
      messageClockLabel({ message_clock: { date: '<script>', time: 123 } })
    ).toBeUndefined()
    const assistant: UIMessage = {
      id: 'a',
      role: 'assistant',
      metadata: { message_clock: { time: '01:00:00' } },
      parts: [{ type: 'text', text: 'reply' }],
    }
    expect(withMessageClocksForModel([assistant])[0]).toBe(assistant)
  })
})
