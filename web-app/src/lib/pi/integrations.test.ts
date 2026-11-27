import { describe, expect, it, vi } from 'vitest'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useMCPServers } from '@/hooks/useMCPServers'
import { invoke } from '@tauri-apps/api/core'
import { strataSessionWindow } from '@/services/pi-agent/tauri'
import {
  connectorEnabled,
  piModelAvailable,
  piSkillPrompt,
} from './integrations'

vi.mock('@tauri-apps/api/core', async (load) => ({
  ...(await load<typeof import('@tauri-apps/api/core')>()),
  invoke: vi.fn(),
}))

describe('pi uses the app configuration', () => {
  it('accepts a Strata model with native tool calling and rejects text-only sessions', () => {
    const provider = { provider: 'strata' } as ModelProvider
    expect(
      piModelAvailable(provider, { capabilities: ['tools'] } as Model)
    ).toBe(true)
    expect(
      piModelAvailable(provider, { capabilities: ['reasoning'] } as Model)
    ).toBe(false)
    expect(
      piModelAvailable(
        { provider: 'foundation-models' } as ModelProvider,
        { capabilities: ['tools'] } as Model
      )
    ).toBe(false)
  })
  it('applies per-thread connector and individual tool settings, including during approval', () => {
    const id = 'pi-test'
    const store = useToolAvailable.getState()
    expect(connectorEnabled(id, 'records', 'lookup')).toBe(true)
    store.setToolsDisabledForThread(id, ['records::lookup'], true)
    expect(connectorEnabled(id, 'records', 'lookup')).toBe(false)
    expect(connectorEnabled(id, 'another-server', 'lookup')).toBe(true)
    useMCPServers.setState({
      mcpServers: {
        records: { active: false, command: 'local', args: [], env: {} },
      },
    })
    expect(connectorEnabled('other', 'records', 'lookup')).toBe(false)
  })
  it('reads the served Strata window from the selected model and provider', async () => {
    const models = [
      { id: 'same', owned_by: 'llamacpp', context_length: 65536 },
      { id: 'same', owned_by: 'strata', context_length: 40960 },
      { id: 'auto', owned_by: 'strata' },
    ]
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ data: models }))
    const base = 'http://127.0.0.1:1337/v1'
    await expect(strataSessionWindow(base, 'fixture', 'same')).resolves.toBe(
      40960
    )
    expect(invoke).toHaveBeenCalledWith('get_local_http', {
      url: base + '/models',
      headers: { Authorization: 'Bearer fixture' },
      timeoutSecs: 5,
    })
    await expect(
      strataSessionWindow(base, undefined, 'auto')
    ).resolves.toBeUndefined()
    await expect(
      strataSessionWindow(base, undefined, 'absent')
    ).resolves.toBeUndefined()
  })
  it('moves an explicitly picked skill to the native pi command position', () => {
    expect(piSkillPrompt('Look up /records PI-42', 'records')).toBe(
      '/skill:records Look up PI-42'
    )
    expect(piSkillPrompt('/compact')).toBe('/compact')
  })
})
