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
  /** Added or changed since the user last allowed it; not offered to the AI. */
  needsReview: boolean
  error: string | null
}

/** A file bundled with a skill besides SKILL.md, shown in Preview. */
export interface AgentSkillFile {
  path: string
  content: string
  /** Cut short for Preview because the file is large. */
  truncated: boolean
}

export interface AgentSkillDetail extends AgentSkill {
  body: string
  files: AgentSkillFile[]
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

/** The user reviewed the skill and chose Allow: record it and switch it on. */
export function approveAgentSkill(name: string): Promise<AgentSkillDetail> {
  return invoke<AgentSkillDetail>('agent_approve_skill', { name })
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
