import type { AgentSkill } from '@/services/agent/skills'

export type AgentSkillSlashQuery = {
  start: number
  end: number
  query: string
}

export type AgentSkillFilterOptions = {
  /**
   * The chat pipeline has no script execution and none of the agent's
   * built-in `os.*` tools, so it can only serve instruction-style skills.
   */
  chatMode: boolean
  /** Tool names the chat pipeline can actually call (MCP ∪ RAG). */
  availableToolNames: ReadonlySet<string>
}

/**
 * Whether a skill can run on the chat pipeline: nothing to script, and every
 * required tool resolvable among the chat-callable tools. All bundled skills
 * require `os.*` tools, so in chat only instruction-style (typically
 * user-authored) skills survive this — intended.
 */
export function isChatCompatibleSkill(
  skill: AgentSkill,
  availableToolNames: ReadonlySet<string>
): boolean {
  return (
    skill.requiresScripts.length === 0 &&
    skill.requiresTools.every((tool) => availableToolNames.has(tool))
  )
}

export function filterAgentSkills(
  skills: AgentSkill[],
  query: string,
  options?: AgentSkillFilterOptions
): AgentSkill[] {
  const normalizedQuery = query.toLowerCase()
  return skills
    .filter((skill) => skill.enabled && skill.compatible && !skill.error)
    .filter(
      (skill) =>
        !options?.chatMode ||
        isChatCompatibleSkill(skill, options.availableToolNames)
    )
    .filter(
      (skill) =>
        !normalizedQuery ||
        skill.name.toLowerCase().includes(normalizedQuery) ||
        skill.description.toLowerCase().includes(normalizedQuery)
    )
}

export function findAvailableAgentSkill(
  skills: AgentSkill[],
  name: string,
  options?: AgentSkillFilterOptions
): AgentSkill | null {
  return (
    skills.find(
      (skill) =>
        skill.name === name &&
        skill.enabled &&
        skill.compatible &&
        !skill.error &&
        skill.unavailableReasons.length === 0 &&
        (!options?.chatMode ||
          isChatCompatibleSkill(skill, options.availableToolNames))
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
