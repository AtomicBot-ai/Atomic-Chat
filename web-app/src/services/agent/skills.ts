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

export function deleteAgentSkill(name: string): Promise<void> {
  return invoke<void>('agent_delete_skill', { name })
}

export function refreshAgentSkills(): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('agent_refresh_skills')
}
