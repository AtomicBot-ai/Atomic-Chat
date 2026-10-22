import { describe, it, expect } from 'vitest'
import {
  removeReasoningContent,
  extractReasoningFromMessage,
} from '../reasoning'

// Built with escapes so the tag characters can never be mangled.
const T_OPEN = '\u003Ct\u0068ink\u003E' //  thinking
const T_CLOSE = '\u003C/t\u0068ink\u003E' //  response

describe('removeReasoningContent', () => {
  it('strips a single complete think block', () => {
    const input = `${T_OPEN}reasoning content${T_CLOSE}\nFinal answer is 2.`
    expect(removeReasoningContent(input)).toBe('Final answer is 2.')
  })

  it('strips every complete think block, not just the first', () => {
    const input =
      `Question\n${T_OPEN}First reasoning pass${T_CLOSE}` +
      `Second reasoning begins\n${T_OPEN}Second reasoning pass${T_CLOSE}\nFinal answer is 2.`
    expect(removeReasoningContent(input)).toBe(
      'Question\nSecond reasoning begins\n\nFinal answer is 2.'
    )
  })

  it('strips an unterminated trailing think block', () => {
    const input = `Question\n${T_OPEN}Reasoning with no closing tag.`
    expect(removeReasoningContent(input)).toBe('Question')
  })

  it('strips multiple unterminated think blocks', () => {
    const input = `${T_OPEN}first${T_CLOSE}\n${T_OPEN}second without close`
    expect(removeReasoningContent(input)).toBe('')
  })

  it('returns content unchanged when there is no reasoning', () => {
    const input = 'Just a normal answer with no think tags.'
    expect(removeReasoningContent(input)).toBe(input)
  })

  it('strips a single complete DeepSeek analysis block', () => {
    const input =
      '\u003C|channel|>analysis\u003C|message|>reasoning\u003C|start|>assistant\u003C|channel|>final\u003C|message|>\nFinal answer is 2.'
    expect(removeReasoningContent(input)).toBe('Final answer is 2.')
  })

  it('strips multiple DeepSeek analysis blocks, not just the first', () => {
    const input =
      'Question\n\u003C|channel|>analysis\u003C|message|>first\u003C|start|>assistant\u003C|channel|>final\u003C|message|>' +
      'Between\n\u003C|channel|>analysis\u003C|message|>second\u003C|start|>assistant\u003C|channel|>final\u003C|message|>\nFinal answer is 2.'
    expect(removeReasoningContent(input)).toBe(
      'Question\nBetween\n\nFinal answer is 2.'
    )
  })

  it('strips an unterminated DeepSeek analysis block', () => {
    const input =
      'Question\n\u003C|channel|>analysis\u003C|message|>no closing tag'
    expect(removeReasoningContent(input)).toBe('Question')
  })
})

describe('extractReasoningFromMessage', () => {
  it('returns reasoning_content when present', () => {
    const msg = { role: 'assistant', content: 'hi', reasoning_content: 'think' }
    expect(extractReasoningFromMessage(msg as never)).toBe('think')
  })

  it('falls back to reasoning field', () => {
    const msg = { role: 'assistant', content: 'hi', reasoning: 'think' }
    expect(extractReasoningFromMessage(msg as never)).toBe('think')
  })

  it('returns null when no reasoning present', () => {
    const msg = { role: 'assistant', content: 'hi' }
    expect(extractReasoningFromMessage(msg as never)).toBeNull()
  })

  it('returns null for null message', () => {
    expect(extractReasoningFromMessage(null as never)).toBeNull()
  })
})