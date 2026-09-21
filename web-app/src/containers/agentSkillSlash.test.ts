import { describe, expect, it } from 'vitest'
import type { AgentSkill } from '@/services/agent/skills'
import {
  filterAgentSkills,
  containsAgentSkillInvocation,
  findAvailableAgentSkill,
  findAgentSkillSlashQuery,
  moveAgentSkillActiveIndex,
  prependAgentSkillInvocation,
  replaceAgentSkillSlashQuery,
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
  it('replaces a slash query with the selected skill at the caret position', () => {
    const query = findAgentSkillSlashQuery('summarize /pdf later', 14)

    expect(query).toEqual({ start: 10, end: 14, query: 'pdf' })
    expect(
      replaceAgentSkillSlashQuery('summarize /pdf later', query!, 'pdf')
    ).toEqual({ value: 'summarize /pdf later', cursor: 14 })
  })

  it('preserves prefix and suffix when completing a skill in mid-sentence', () => {
    const value = 'Use the attached /pd to make a report'
    const query = findAgentSkillSlashQuery(value, 20)

    expect(query).toEqual({ start: 17, end: 20, query: 'pd' })
    expect(replaceAgentSkillSlashQuery(value, query!, 'pdf')).toEqual({
      value: 'Use the attached /pdf to make a report',
      cursor: 21,
    })
  })

  it('recognizes only a complete inline invocation', () => {
    expect(containsAgentSkillInvocation('prefix /pdf suffix', 'pdf')).toBe(true)
    expect(containsAgentSkillInvocation('prefix /pdf, suffix', 'pdf')).toBe(
      true
    )
    expect(containsAgentSkillInvocation('prefix /pdf-extra suffix', 'pdf')).toBe(
      false
    )
    expect(containsAgentSkillInvocation('plain prompt', 'pdf')).toBe(false)
  })

  it('materializes a preselected skill as prompt text without duplication', () => {
    expect(prependAgentSkillInvocation('make a report', 'pdf')).toEqual({
      value: '/pdf make a report',
      cursor: 4,
    })
    expect(prependAgentSkillInvocation('prefix /pdf suffix', 'pdf')).toEqual({
      value: 'prefix /pdf suffix',
      cursor: 18,
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

  // Bundled skills all need the agent's `os.*` tools; the chat composer must
  // still offer them, or "/" only ever lists user-authored skills there.
  it('lists and resolves skills that need agent tools or scripts', () => {
    const skills = [
      skill('instructions', 'Plain guidance'),
      skill('scripted', 'Runs a script', {
        requiresScripts: ['run.sh'],
        reserved: true,
      }),
      skill('os-bound', 'Needs the shell', {
        requiresTools: ['os.shell.run'],
        reserved: true,
      }),
    ]

    expect(filterAgentSkills(skills, '').map(({ name }) => name)).toEqual([
      'instructions',
      'scripted',
      'os-bound',
    ])
    expect(findAvailableAgentSkill(skills, 'os-bound')?.name).toBe('os-bound')
    expect(findAvailableAgentSkill(skills, 'scripted')?.name).toBe('scripted')
  })
})
