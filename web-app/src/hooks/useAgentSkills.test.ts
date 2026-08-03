import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentSkill,
  deleteAgentSkill,
  exportAgentSkill,
  getAgentSkill,
  importAgentSkill,
  listAgentSkills,
  refreshAgentSkills,
  setAgentSkillEnabled,
  updateAgentSkill,
} from '@/services/agent/skills'
import type { DialogService } from '@/services/dialog/types'
import { seedServiceHub } from '@/test/service-hub'
import { useAgentSkills } from './useAgentSkills'

vi.mock('@/services/agent/skills', () => ({
  createAgentSkill: vi.fn(),
  deleteAgentSkill: vi.fn(),
  exportAgentSkill: vi.fn(),
  getAgentSkill: vi.fn(),
  importAgentSkill: vi.fn(),
  listAgentSkills: vi.fn(),
  refreshAgentSkills: vi.fn(),
  setAgentSkillEnabled: vi.fn(),
  updateAgentSkill: vi.fn(),
}))

const saveDialog = vi.hoisted(() => vi.fn())

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
    seedServiceHub({
      dialog: {
        save: saveDialog,
      } as DialogService,
    })
    vi.mocked(listAgentSkills).mockResolvedValue([skill])
    vi.mocked(refreshAgentSkills).mockResolvedValue([skill])
    vi.mocked(getAgentSkill).mockResolvedValue({ ...skill, body: '# Body' })
    vi.mocked(createAgentSkill).mockResolvedValue({ ...skill, body: '# Body' })
    vi.mocked(importAgentSkill).mockResolvedValue({ ...skill, body: '# Body' })
    vi.mocked(setAgentSkillEnabled).mockResolvedValue()
    vi.mocked(deleteAgentSkill).mockResolvedValue()
    vi.mocked(exportAgentSkill).mockResolvedValue()
    vi.mocked(updateAgentSkill).mockResolvedValue({ ...skill, body: '# Body' })
    saveDialog.mockReset()
  })

  it('selects the first skill alphabetically after loading', async () => {
    const alpha = { ...skill, name: 'alpha' }
    const zulu = { ...skill, name: 'zulu' }
    vi.mocked(listAgentSkills).mockResolvedValue([zulu, alpha])
    vi.mocked(getAgentSkill).mockImplementation(async (name) => ({
      ...(name === 'alpha' ? alpha : zulu),
      body: '# Body',
    }))

    const { result } = renderHook(() => useAgentSkills())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.skills.map(({ name }) => name)).toEqual([
      'alpha',
      'zulu',
    ])
    expect(result.current.selected?.name).toBe('alpha')
  })

  it('creates and imports a skill, then selects it', async () => {
    const { result } = renderHook(() => useAgentSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const request = {
      name: skill.name,
      description: skill.description,
      instructions: '# Body',
    }
    await act(() => result.current.addCreated(request))
    expect(createAgentSkill).toHaveBeenCalledWith(request)
    expect(result.current.selected?.name).toBe(skill.name)

    await act(() => result.current.addImported('/tmp/custom-skill'))
    expect(importAgentSkill).toHaveBeenCalledWith('/tmp/custom-skill')
    expect(result.current.selected?.name).toBe(skill.name)
  })

  it('loads, selects, enables, and selects the next skill after deletion', async () => {
    const nextSkill = { ...skill, name: 'next-skill' }
    vi.mocked(listAgentSkills)
      .mockResolvedValueOnce([skill, nextSkill])
      .mockResolvedValueOnce([skill, nextSkill])
      .mockResolvedValueOnce([nextSkill])
    vi.mocked(getAgentSkill).mockImplementation(async (name) => ({
      ...(name === skill.name ? skill : nextSkill),
      body: '# Body',
    }))
    const { result } = renderHook(() => useAgentSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.select(skill.name))
    expect(result.current.selected?.body).toBe('# Body')

    await act(() => result.current.setEnabled(skill.name, false))
    expect(setAgentSkillEnabled).toHaveBeenCalledWith(skill.name, false)

    await act(() => result.current.remove(skill.name))
    expect(deleteAgentSkill).toHaveBeenCalledWith(skill.name)
    expect(result.current.selected?.name).toBe(nextSkill.name)
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

  it('updates and exports a skill through the save dialog', async () => {
    const updated = {
      ...skill,
      description: 'Updated',
      body: '# Updated body',
    }
    vi.mocked(updateAgentSkill).mockResolvedValue(updated)
    saveDialog.mockResolvedValue('/tmp/custom-skill.skill')
    const { result } = renderHook(() => useAgentSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() =>
      result.current.update({
        name: skill.name,
        description: 'Updated',
        instructions: '# Updated body',
      })
    )
    expect(result.current.selected).toEqual(updated)

    let exported = false
    await act(async () => {
      exported = await result.current.exportSkill(skill.name)
    })
    expect(exported).toBe(true)
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: 'custom-skill.skill',
      filters: [{ name: 'Atomic Chat Skill', extensions: ['skill'] }],
    })
    expect(exportAgentSkill).toHaveBeenCalledWith(
      skill.name,
      '/tmp/custom-skill.skill'
    )
  })
})
