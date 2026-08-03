import { describe, expect, it } from 'vitest'
import type { AgentSkill } from '@/services/agent/skills'
import {
  filterAgentSkills,
  findAvailableAgentSkill,
  findAgentSkillSlashQuery,
  moveAgentSkillActiveIndex,
  removeAgentSkillSlashQuery,
} from './agentSkillSlash'

const skill = (
  name: string,
  description: string,
  overrides: Partial<AgentSkill> = {}
): AgentSkill => ({
  name,
  description,
  version: '1.0.0',
  requiresTools: [],
  requiresScripts: [],
  dangerous: false,
  platforms: null,
  enabled: true,
  compatible: true,
  reserved: false,
  unavailableReasons: [],
  error: null,
  ...overrides,
})

describe('agent skill slash picker', () => {
  it('finds and removes the slash query after selection', () => {
    const query = findAgentSkillSlashQuery('summarize /pdf later', 14)

    expect(query).toEqual({ start: 10, end: 14, query: 'pdf' })
    expect(removeAgentSkillSlashQuery('summarize /pdf later', query!)).toEqual({
      value: 'summarize  later',
      cursor: 10,
    })
  })

  it('filters by name or description and excludes unavailable skills', () => {
    const skills = [
      skill('pdf', 'Read documents'),
      skill('notes', 'Capture PDF excerpts'),
      skill('disabled', 'PDF', { enabled: false }),
      skill('incompatible', 'PDF', { compatible: false }),
      skill('broken', 'PDF', { error: 'invalid manifest' }),
    ]

    expect(filterAgentSkills(skills, 'pdf').map(({ name }) => name)).toEqual([
      'pdf',
      'notes',
    ])
  })

  it('finds only a skill eligible for Agent selection', () => {
    const skills = [
      skill('disabled', 'Disabled', { enabled: false }),
      skill('ready', 'Ready'),
    ]

    expect(findAvailableAgentSkill(skills, 'ready')?.name).toBe('ready')
    expect(findAvailableAgentSkill(skills, 'disabled')).toBeNull()
    expect(findAvailableAgentSkill(skills, 'missing')).toBeNull()
  })

  it('wraps keyboard selection in both directions', () => {
    expect(moveAgentSkillActiveIndex(0, -1, 3)).toBe(2)
    expect(moveAgentSkillActiveIndex(2, 1, 3)).toBe(0)
  })
})
