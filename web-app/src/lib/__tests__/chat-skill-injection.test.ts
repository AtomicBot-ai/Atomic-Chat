import { describe, expect, it } from 'vitest'
import {
  CHAT_SKILLS_CAP,
  CHAT_SKILL_BODY_MAX_CHARS,
  CHAT_SKILLS_BLOCK_MAX_CHARS,
  collectSkillNamesFromMessages,
  composeSystemMessage,
  renderChatSkillsBlock,
} from '@/lib/chat-skill-injection'

const userMessage = (skillName?: string) => ({
  role: 'user' as const,
  metadata: skillName ? { agent_skill_name: skillName } : undefined,
})

describe('collectSkillNamesFromMessages', () => {
  it('collects user-invoked skills, deduped keeping the most recent', () => {
    const names = collectSkillNamesFromMessages([
      userMessage('pdf'),
      { role: 'assistant' },
      userMessage('notes'),
      userMessage('pdf'),
    ])
    expect(names).toEqual(['notes', 'pdf'])
  })

  it('ignores messages without valid skill metadata', () => {
    expect(
      collectSkillNamesFromMessages([
        userMessage(),
        { role: 'user', metadata: { agent_skill_name: 42 } },
        { role: 'assistant', metadata: { agent_skill_name: 'ignored' } },
      ])
    ).toEqual([])
  })

  it('caps at the last CHAT_SKILLS_CAP skills', () => {
    const many = Array.from({ length: CHAT_SKILLS_CAP + 3 }, (_, i) =>
      userMessage(`skill-${i}`)
    )
    const names = collectSkillNamesFromMessages(many)
    expect(names).toHaveLength(CHAT_SKILLS_CAP)
    expect(names[names.length - 1]).toBe(`skill-${CHAT_SKILLS_CAP + 2}`)
  })
})

describe('renderChatSkillsBlock', () => {
  it('returns undefined for no skills', () => {
    expect(renderChatSkillsBlock([])).toBeUndefined()
  })

  it('renders name, version and body', () => {
    const block = renderChatSkillsBlock([
      { name: 'pdf', version: '1.0.0', body: 'Do PDF things.' },
    ])
    expect(block).toContain('## Invoked skills')
    expect(block).toContain('# skill: pdf (v1.0.0)')
    expect(block).toContain('Do PDF things.')
  })

  it('truncates oversized bodies and the whole block', () => {
    const huge = 'x'.repeat(CHAT_SKILL_BODY_MAX_CHARS * 3)
    const one = renderChatSkillsBlock([
      { name: 'big', version: '1', body: huge },
    ])!
    expect(one.length).toBeLessThanOrEqual(CHAT_SKILL_BODY_MAX_CHARS + 200)
    expect(one).toContain('[truncated]')

    const block = renderChatSkillsBlock(
      Array.from({ length: 4 }, (_, i) => ({
        name: `s${i}`,
        version: '1',
        body: huge,
      }))
    )!
    expect(block.length).toBeLessThanOrEqual(CHAT_SKILLS_BLOCK_MAX_CHARS)
  })
})

describe('composeSystemMessage', () => {
  it('joins base and skills block', () => {
    expect(composeSystemMessage('base', 'skills')).toBe('base\n\nskills')
  })

  it('passes through a lone value and collapses emptiness to undefined', () => {
    expect(composeSystemMessage('base', undefined)).toBe('base')
    expect(composeSystemMessage(undefined, 'skills')).toBe('skills')
    expect(composeSystemMessage(undefined, undefined)).toBeUndefined()
    expect(composeSystemMessage('', '')).toBeUndefined()
  })
})
