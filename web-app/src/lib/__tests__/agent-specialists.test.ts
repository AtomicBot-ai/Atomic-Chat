import { describe, expect, it } from 'vitest'

import {
  agentToolPacks,
  buildAgentSpecialists,
  MAX_AGENT_SPECIALISTS,
} from '../agent-specialists'

function assistant(overrides: Partial<Assistant>): Assistant {
  return {
    id: 'id',
    name: 'Assistant',
    created_at: 0,
    instructions: '',
    parameters: {},
    ...overrides,
  }
}

const network = assistant({
  id: 'network',
  name: 'Network',
  description: 'Diagnoses Wi-Fi, DNS and LAN problems',
  instructions: 'Today is {{current_date}}. Prefer read-only checks.',
  specialist: true,
})

describe('buildAgentSpecialists', () => {
  it('offers only assistants marked as specialists', () => {
    const plain = assistant({ id: 'plain', name: 'Plain', description: 'x' })
    expect(buildAgentSpecialists([plain, network], undefined)).toEqual([
      expect.objectContaining({ name: 'Network' }),
    ])
  })

  it('never offers the thread assistant to itself', () => {
    expect(buildAgentSpecialists([network], 'network')).toEqual([])
  })

  it('skips a specialist without a description', () => {
    const vague = assistant({
      id: 'vague',
      name: 'Vague',
      description: '  ',
      specialist: true,
    })
    expect(buildAgentSpecialists([vague], undefined)).toEqual([])
  })

  it('renders instruction templates like the thread assistant does', () => {
    const [specialist] = buildAgentSpecialists([network], undefined)
    expect(specialist.instructions).not.toContain('{{current_date}}')
    expect(specialist.instructions).toContain('Prefer read-only checks.')
  })

  it('sends no instructions for a specialist without any', () => {
    const bare = assistant({ ...network, instructions: '' })
    expect(buildAgentSpecialists([bare], undefined)[0].instructions).toBe(
      undefined
    )
  })

  it('keeps the first of two specialists that share a name', () => {
    const duplicate = assistant({
      ...network,
      id: 'network-2',
      name: 'network',
      description: 'Second copy',
    })
    const specialists = buildAgentSpecialists([network, duplicate], undefined)
    expect(specialists).toHaveLength(1)
    expect(specialists[0].description).toBe(network.description)
  })

  it('caps the roster at the backend limit', () => {
    const many = Array.from({ length: MAX_AGENT_SPECIALISTS + 3 }, (_, i) =>
      assistant({
        id: `s${i}`,
        name: `Specialist ${i}`,
        description: 'Does things',
        specialist: true,
      })
    )
    expect(buildAgentSpecialists(many, undefined)).toHaveLength(
      MAX_AGENT_SPECIALISTS
    )
  })

  it('passes along known tool packs and drops unknown ones', () => {
    const tooled = assistant({
      ...network,
      tool_packs: ['network', 'teleportation'],
    })
    expect(buildAgentSpecialists([tooled], undefined)[0].tool_packs).toEqual([
      'network',
    ])
    expect(agentToolPacks(undefined)).toEqual([])
  })
})
