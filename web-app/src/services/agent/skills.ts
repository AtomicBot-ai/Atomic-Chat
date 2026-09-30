import { invoke } from '@tauri-apps/api/core'
import { bumpAgentSkillRevision } from '@/lib/agent-skill-revision'

export type AgentSkillPlatform = 'darwin' | 'win32' | 'linux'

export interface AgentSkill {
  name: string
  description: string
  version: string
  requiresTools: string[]
  requiresScripts: string[]
  dangerous: boolean
  platforms: AgentSkillPlatform[] | null
  enabled: boolean
  compatible: boolean
  reserved: boolean
  unavailableReasons: string[]
  error: string | null
  modifiedAtMs?: number | null
}

export interface AgentSkillDetail extends AgentSkill {
  body: string
}

export interface CreateAgentSkillRequest {
  name: string
  description: string
  instructions: string
}

export interface UpdateAgentSkillRequest {
  name: string
  description: string
  instructions: string
}

/**
 * Bump the skill revision after a successful mutation, passing the result
 * through. Anything memoizing a SKILL.md body (the chat transport) watches
 * this counter and drops its cache, so an edit reaches the model on the next
 * send instead of at the next app restart.
 */
function withSkillRevisionBump<T>(result: T): T {
  bumpAgentSkillRevision()
  return result
}

export function listAgentSkills(): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('agent_list_skills')
}

export function getAgentSkill(name: string): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_get_skill', { name })
}

export function setAgentSkillEnabled(
  name: string,
  enabled: boolean
): Promise<void> {
  return invoke<void>('agent_set_skill_enabled', { name, enabled }).then(
    withSkillRevisionBump
  )
}

export function createAgentSkill(
  request: CreateAgentSkillRequest
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_create_skill', { request }).then(
    withSkillRevisionBump
  )
}

export function importAgentSkill(
  sourcePath: string
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_import_skill', { sourcePath }).then(
    withSkillRevisionBump
  )
}

export function updateAgentSkill(
  request: UpdateAgentSkillRequest
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_update_skill', { request }).then(
    withSkillRevisionBump
  )
}

export function exportAgentSkill(
  name: string,
  targetPath: string
): Promise<void> {
  return invoke<void>('agent_export_skill', { name, targetPath })
}

export function deleteAgentSkill(name: string): Promise<void> {
  return invoke<void>('agent_delete_skill', { name }).then(withSkillRevisionBump)
}

export function refreshAgentSkills(): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('agent_refresh_skills')
}
