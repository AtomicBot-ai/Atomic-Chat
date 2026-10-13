import { describe, expect, it } from 'vitest'
import {
  applyPrivacyGate,
  createPrivacyState,
  redactText,
  rehydrateText,
  rehydrateUIMessageStream,
  scanSensitiveText,
  StreamingRehydrator,
} from '../privacy-gate'

type Chunk = { type: string } & Record<string, unknown>

async function collect(chunks: Chunk[], state = createPrivacyState()) {
  const source = new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const out: Chunk[] = []
  const reader = rehydrateUIMessageStream(source, state).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

function splitInto(text: string, size: number): string[] {
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size)
    pieces.push(text.slice(i, i + size))
  return pieces
}

describe('privacy gate', () => {
  it('redacts sensitive values with request-scoped collision-resistant tokens', () => {
    const state = createPrivacyState([], 'abc123')
    const input =
      'Email chef@example.com and use sk-abcdefghijklmnopqrstuvwxyz123456'
    const redacted = redactText(input, state)

    expect(redacted).not.toContain('chef@example.com')
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(redacted).toMatch(/\[RDM_abc123_EMAIL_1\]/)
    expect(redacted).toMatch(/\[RDM_abc123_APIKEY_1\]/)
    expect(rehydrateText(redacted, state)).toBe(input)
  })

  it('applies custom terms case-insensitively', () => {
    const state = createPrivacyState(['Project Falcon'], 'term1')
    const redacted = redactText('project falcon is internal', state)
    expect(redacted).toContain('[RDM_term1_TERM_1]')
    expect(redacted).not.toMatch(/project falcon/i)
  })

  it('restores the original casing for custom private terms', () => {
    const state = createPrivacyState(['Project Falcon'], 'case1')
    const redacted = redactText('PROJECT FALCON is private', state)
    expect(rehydrateText(redacted, state)).toBe('PROJECT FALCON is private')
  })

  it('keeps originals out of a fake remote egress payload', () => {
    const outbound = applyPrivacyGate({
      messages: [{ role: 'user', content: 'ops@example.com uses 10.0.0.8' }],
      system: 'API key sk-abcdefghijklmnopqrstuvwxyz123456',
      customTerms: ['Northstar'],
      requestId: 'canary',
    })
    const wirePayload = JSON.stringify({
      messages: outbound.messages,
      system: outbound.system,
    })
    expect(wirePayload).not.toContain('ops@example.com')
    expect(wirePayload).not.toContain('10.0.0.8')
    expect(wirePayload).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })
  it('does not fabricate hits for invalid card numbers', () => {
    expect(scanSensitiveText('card 4111 1111 1111 1112')).toEqual([])
  })

  it('redacts strings nested in model messages and the system prompt', () => {
    const result = applyPrivacyGate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Contact ops@example.com' },
            { type: 'image', image: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
      system: 'Internal host 10.1.2.3',
      customTerms: [],
      requestId: 'req9',
    })

    expect(JSON.stringify(result.messages)).not.toContain('ops@example.com')
    expect(result.system).not.toContain('10.1.2.3')
    expect(JSON.stringify(result.messages)).toContain(
      'data:image/png;base64,AAAA'
    )
  })

  it('rehydrates only tokens created by this request', () => {
    const state = createPrivacyState([], 'safe')
    const redacted = redactText('me@example.com', state)
    expect(rehydrateText(redacted + ' [RDM_other_EMAIL_1]', state)).toBe(
      'me@example.com [RDM_other_EMAIL_1]'
    )
  })

  it('restores a placeholder split across streamed deltas', () => {
    const state = createPrivacyState([], 'abc123')
    const token = redactText('me@example.com', state)
    const rehydrator = new StreamingRehydrator(state)
    const reply = `Write to ${token} today.`
    const shown =
      splitInto(reply, 3)
        .map((piece) => rehydrator.push(piece))
        .join('') + rehydrator.flush()
    expect(shown).toBe('Write to me@example.com today.')
  })

  it('does not hold back brackets that cannot become a placeholder', () => {
    const state = createPrivacyState([], 'abc123')
    redactText('me@example.com', state)
    const rehydrator = new StreamingRehydrator(state)
    expect(rehydrator.push('see [1] and [x')).toBe('see [1] and [x')
    expect(rehydrator.push(' and [RDM_ab')).toBe(' and ')
    expect(rehydrator.flush()).toBe('[RDM_ab')
  })

  it('rehydrates a UI stream per part without losing or reordering text', async () => {
    const state = createPrivacyState([], 'abc123')
    const email = redactText('me@example.com', state)
    const ip = redactText('10.0.0.7', state)
    const text = `Mail ${email} from ${ip}`
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      ...splitInto(text, 4).map((delta) => ({
        type: 'text-delta',
        id: 't1',
        delta,
      })),
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'send' },
      ...splitInto(`{"to":"${email}"}`, 5).map((inputTextDelta) => ({
        type: 'tool-input-delta',
        toolCallId: 'c1',
        inputTextDelta,
      })),
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'send',
        input: { to: email },
      },
      { type: 'finish' },
    ]

    const out = await collect(chunks, state)

    const shownText = out
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join('')
    expect(shownText).toBe('Mail me@example.com from 10.0.0.7')
    const toolText = out
      .filter((chunk) => chunk.type === 'tool-input-delta')
      .map((chunk) => chunk.inputTextDelta)
      .join('')
    expect(toolText).toBe('{"to":"me@example.com"}')
    expect(out.find((chunk) => chunk.type === 'tool-input-available')).toEqual(
      expect.objectContaining({ input: { to: 'me@example.com' } })
    )
    const types = out.map((chunk) => chunk.type)
    expect(types.indexOf('text-end')).toBeGreaterThan(
      types.lastIndexOf('text-delta')
    )
    expect(JSON.stringify(out)).not.toContain('RDM_')
  })

  it('releases a held-back tail when the stream ends without an end chunk', async () => {
    const state = createPrivacyState([], 'abc123')
    redactText('me@example.com', state)
    const out = await collect(
      [{ type: 'text-delta', id: 't1', delta: 'cut off [RDM_abc' }],
      state
    )
    expect(out.map((chunk) => chunk.delta).join('')).toBe('cut off [RDM_abc')
  })
})
