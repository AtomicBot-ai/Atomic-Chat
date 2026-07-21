import { describe, expect, it } from 'vitest'
import { readAgentSkillName } from './agent-skill-selection'

describe('readAgentSkillName', () => {
  it('restores a selected skill from user-message metadata', () => {
    expect(readAgentSkillName({ agent_skill_name: 'pdf' })).toBe('pdf')
  })

  it('ignores absent or invalid metadata values', () => {
    expect(readAgentSkillName({})).toBeUndefined()
    expect(readAgentSkillName({ agent_skill_name: '' })).toBeUndefined()
    expect(readAgentSkillName({ agent_skill_name: 42 })).toBeUndefined()
  })
})
