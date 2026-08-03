export function readAgentSkillName(
  metadata: Record<string, unknown>
): string | undefined {
  const value = metadata.agent_skill_name
  return typeof value === 'string' && value ? value : undefined
}
