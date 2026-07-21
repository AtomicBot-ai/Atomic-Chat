import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteAgentSkill,
  getAgentSkill,
  listAgentSkills,
  refreshAgentSkills,
  setAgentSkillEnabled,
} from './skills'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('agent skills service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('uses typed Agent skills commands and payloads', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)

    await listAgentSkills()
    await getAgentSkill('pdf')
    await setAgentSkillEnabled('pdf', false)
    await deleteAgentSkill('custom-skill')
    await refreshAgentSkills()

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['agent_list_skills'],
      ['agent_get_skill', { name: 'pdf' }],
      ['agent_set_skill_enabled', { name: 'pdf', enabled: false }],
      ['agent_delete_skill', { name: 'custom-skill' }],
      ['agent_refresh_skills'],
    ])
  })
})
