import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, toastSuccess, toastWarning } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}))

// Nothing here may reach a real agent's process.
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, warning: toastWarning },
}))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useModelProvider } from '@/hooks/useModelProvider'

import {
  answerAgentSwitch,
  decideAgentsBeforeSwitch,
  registerAgentReopen,
  reopenAgentsAfterSwitch,
  reportAgentsStopped,
  stopAgentsForSwitch,
  useAgentSwitchQuestion,
} from '../agentSwitchGuard'

const QWEN = { modelId: 'qwen3.5-4b', providerName: 'llamacpp-upstream' }
const GEMMA = {
  modelId: 'unsloth/gemma-4-e4b-it-GGUF',
  providerName: 'llamacpp-upstream',
}
const GPT = { modelId: 'gpt-5.2', providerName: 'openai' }

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!

/** The terminals `list_agent_terminals` reports. */
function running(terminals: Array<{ agentId: string; model: string | null }>) {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'list_agent_terminals') return terminals
    if (command === 'stop_agent_terminal') return true
    throw new Error(`unexpected ${command}`)
  })
}

/** Let the question reach the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('asking before a switch cuts off running agents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAgentSwitchQuestion.setState({ pending: null })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [
            { id: QWEN.modelId },
            { id: GEMMA.modelId, displayName: 'Gemma 4 E4B' },
          ],
        },
        { provider: 'openai', active: true, models: [{ id: GPT.modelId }] },
      ] as unknown as ModelProvider[],
    })
  })

  afterEach(() => answerAgentSwitch(false))

  it('lets the switch go on when no agent Atomic Chat opened runs, or the app cannot tell', async () => {
    running([])
    await expect(decideAgentsBeforeSwitch(GEMMA)).resolves.toEqual({
      kind: 'proceed',
    })
    invoke.mockRejectedValue(new Error('not in Tauri'))
    await expect(decideAgentsBeforeSwitch(GEMMA)).resolves.toEqual({
      kind: 'proceed',
    })
    expect(useAgentSwitchQuestion.getState().pending).toBeNull()
  })

  it('leaves agents already on the target model alone, and agents it does not know', async () => {
    running([
      { agentId: 'codex', model: GEMMA.modelId },
      { agentId: 'retired-agent', model: QWEN.modelId },
    ])
    await expect(decideAgentsBeforeSwitch(GEMMA)).resolves.toEqual({
      kind: 'proceed',
    })
    expect(useAgentSwitchQuestion.getState().pending).toBeNull()
  })

  it('asks about the agents on another model and restarts them on a yes', async () => {
    running([
      { agentId: 'claude-code', model: QWEN.modelId },
      { agentId: 'codex', model: GEMMA.modelId },
      { agentId: 'opencode', model: null },
    ])
    const decision = decideAgentsBeforeSwitch(GEMMA)
    await settle()

    const pending = useAgentSwitchQuestion.getState().pending
    expect(pending?.agents.map((a) => a.id)).toEqual([
      'claude-code',
      'opencode',
    ])
    expect(pending?.model).toBe('Gemma 4 E4B')
    expect(pending?.cloudProvider).toBeNull()

    answerAgentSwitch(true)
    await expect(decision).resolves.toEqual({
      kind: 'restart',
      agents: [agent('claude-code'), agent('opencode')],
    })
    expect(useAgentSwitchQuestion.getState().pending).toBeNull()
  })

  it('changes nothing on a no', async () => {
    running([{ agentId: 'claude-code', model: QWEN.modelId }])
    const decision = decideAgentsBeforeSwitch(GEMMA)
    await settle()
    answerAgentSwitch(false)
    await expect(decision).resolves.toEqual({ kind: 'declined' })
    expect(invoke).not.toHaveBeenCalledWith(
      'stop_agent_terminal',
      expect.anything()
    )
  })

  it('names the cloud provider the agents would be sent to', async () => {
    running([{ agentId: 'codex', model: QWEN.modelId }])
    const decision = decideAgentsBeforeSwitch(GPT)
    await settle()
    expect(useAgentSwitchQuestion.getState().pending).toMatchObject({
      // The name the model dropdown shows for it.
      model: 'Gpt 5.2',
      cloudProvider: 'OpenAI',
    })
    answerAgentSwitch(true)
    await expect(decision).resolves.toMatchObject({ kind: 'restart' })
  })

  it('hands the restart to the first switch only when two wait on one question', async () => {
    running([{ agentId: 'codex', model: QWEN.modelId }])
    const first = decideAgentsBeforeSwitch(GEMMA)
    await settle()
    const second = decideAgentsBeforeSwitch(GEMMA)
    await settle()
    answerAgentSwitch(true)
    const decisions = await Promise.all([first, second])
    expect(decisions.map((d) => d.kind).sort()).toEqual(['proceed', 'restart'])
  })

  it('answers no to a question a switch to another model replaced', async () => {
    running([{ agentId: 'codex', model: QWEN.modelId }])
    const first = decideAgentsBeforeSwitch(GEMMA)
    await settle()
    const second = decideAgentsBeforeSwitch(GPT)
    await expect(first).resolves.toEqual({ kind: 'declined' })
    await settle()
    expect(useAgentSwitchQuestion.getState().pending?.model).toBe('Gpt 5.2')
    answerAgentSwitch(true)
    await expect(second).resolves.toMatchObject({ kind: 'restart' })
  })

  it('stops each agent, then opens each again on the served model and says so once', async () => {
    running([])
    await stopAgentsForSwitch([agent('claude-code'), agent('codex')])
    expect(
      invoke.mock.calls.filter(([c]) => c === 'stop_agent_terminal')
    ).toEqual([
      ['stop_agent_terminal', { agentId: 'claude-code' }],
      ['stop_agent_terminal', { agentId: 'codex' }],
    ])

    const reopened: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unregister = registerAgentReopen(async (a) => {
      reopened.push(a.id)
      if (a.id === 'claude-code') throw new Error('Terminal did not open')
    })
    await reopenAgentsAfterSwitch([agent('claude-code'), agent('codex')], GEMMA)
    unregister()
    warn.mockRestore()

    // One failure does not keep the next agent closed.
    expect(reopened).toEqual(['claude-code', 'codex'])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Restarted on Gemma 4 E4B: Claude Code, Codex CLI',
      expect.objectContaining({ id: 'connected-agents-model' })
    )

    // Nothing registered (no dialog mounted): nothing to open with.
    await reopenAgentsAfterSwitch([agent('codex')], GEMMA)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('says when agents were stopped for a switch that did not happen', () => {
    reportAgentsStopped([agent('codex')])
    expect(toastWarning.mock.calls).toHaveLength(1)
    const [title, options] = toastWarning.mock.calls[0]
    expect(title).toBe('Agents stopped: the model did not switch')
    // Same id as the follow toast, so it replaces rather than stacks.
    expect(options).toMatchObject({ id: 'connected-agents-model' })
    expect(options.description).toContain('Codex CLI')
  })
})
