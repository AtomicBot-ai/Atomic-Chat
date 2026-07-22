import { invoke } from '@tauri-apps/api/core'

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
  return invoke<void>('agent_set_skill_enabled', { name, enabled })
}

export function createAgentSkill(
  request: CreateAgentSkillRequest
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_create_skill', { request })
}

export function importAgentSkill(
  sourcePath: string
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_import_skill', { sourcePath })
}

export function updateAgentSkill(
  request: UpdateAgentSkillRequest
): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_update_skill', { request })
}

export function exportAgentSkill(
  name: string,
  targetPath: string
): Promise<void> {
  return invoke<void>('agent_export_skill', { name, targetPath })
}

export function deleteAgentSkill(name: string): Promise<void> {
  return invoke<void>('agent_delete_skill', { name })
}

export function refreshAgentSkills(): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('agent_refresh_skills')
}
