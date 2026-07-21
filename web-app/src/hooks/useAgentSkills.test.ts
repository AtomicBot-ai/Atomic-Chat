import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteAgentSkill,
  getAgentSkill,
  listAgentSkills,
  refreshAgentSkills,
  setAgentSkillEnabled,
} from '@/services/agent/skills'
import { useAgentSkills } from './useAgentSkills'

vi.mock('@/services/agent/skills', () => ({
  deleteAgentSkill: vi.fn(),
  getAgentSkill: vi.fn(),
  listAgentSkills: vi.fn(),
  refreshAgentSkills: vi.fn(),
  setAgentSkillEnabled: vi.fn(),
}))

const skill = {
  name: 'custom-skill',
  description: 'Custom',
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
}

describe('useAgentSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listAgentSkills).mockResolvedValue([skill])
    vi.mocked(refreshAgentSkills).mockResolvedValue([skill])
    vi.mocked(getAgentSkill).mockResolvedValue({ ...skill, body: '# Body' })
    vi.mocked(setAgentSkillEnabled).mockResolvedValue()
    vi.mocked(deleteAgentSkill).mockResolvedValue()
  })

  it('loads, selects, enables, and deletes skills', async () => {
    const { result } = renderHook(() => useAgentSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.select(skill.name))
    expect(result.current.selected?.body).toBe('# Body')

    await act(() => result.current.setEnabled(skill.name, false))
    expect(setAgentSkillEnabled).toHaveBeenCalledWith(skill.name, false)

    await act(() => result.current.remove(skill.name))
    expect(deleteAgentSkill).toHaveBeenCalledWith(skill.name)
    expect(result.current.selected).toBeNull()
  })

  it('reloads the selected skill detail during refresh', async () => {
    const { result } = renderHook(() => useAgentSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.select(skill.name))

    vi.mocked(getAgentSkill).mockResolvedValue({
      ...skill,
      enabled: false,
      body: '# Updated body',
    })
    await act(() => result.current.load(true))

    expect(result.current.selected).toMatchObject({
      enabled: false,
      body: '# Updated body',
    })
  })
})
