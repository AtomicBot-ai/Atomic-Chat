import type { AgentSkill } from '@/services/agent/skills'

export type AgentSkillSlashQuery = {
  start: number
  end: number
  query: string
}

export function filterAgentSkills(
  skills: AgentSkill[],
  query: string
): AgentSkill[] {
  const normalizedQuery = query.toLowerCase()
  return skills
    .filter((skill) => skill.enabled && skill.compatible && !skill.error)
    .filter(
      (skill) =>
        !normalizedQuery ||
        skill.name.toLowerCase().includes(normalizedQuery) ||
        skill.description.toLowerCase().includes(normalizedQuery)
    )
}

export function findAvailableAgentSkill(
  skills: AgentSkill[],
  name: string
): AgentSkill | null {
  return (
    skills.find(
      (skill) =>
        skill.name === name &&
        skill.enabled &&
        skill.compatible &&
        !skill.error &&
        skill.unavailableReasons.length === 0
    ) ?? null
  )
}

export function moveAgentSkillActiveIndex(
  current: number,
  direction: 1 | -1,
  count: number
): number {
  if (count <= 0) return 0
  return (current + direction + count) % count
}

export function findAgentSkillSlashQuery(
  value: string,
  cursor: number | null
): AgentSkillSlashQuery | null {
  if (cursor === null) return null

  const prefix = value.slice(0, cursor)
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(prefix)
  if (!match) return null

  const slashOffset = match[0].lastIndexOf('/')
  return {
    start: match.index + slashOffset,
    end: cursor,
    query: match[1].toLowerCase(),
  }
}

export function removeAgentSkillSlashQuery(
  value: string,
  query: AgentSkillSlashQuery
): { value: string; cursor: number } {
  return {
    value: `${value.slice(0, query.start)}${value.slice(query.end)}`,
    cursor: query.start,
  }
}
