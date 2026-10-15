import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { resolveThreadExecutionRoute } from '@/lib/thread-execution-route'

const platformFeatures = vi.hoisted(() => ({}) as Record<string, boolean>)
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  Object.assign(platformFeatures, actual.PlatformFeatures)
  return { ...actual, PlatformFeatures: platformFeatures }
})

function selectLocalModel() {
  const model = { id: 'qwen', capabilities: ['tools'], settings: {} } as Model
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp',
        active: true,
        models: [model],
        settings: [],
      } as ModelProvider,
    ],
    selectedProvider: 'llamacpp',
    selectedModel: model,
  })
}

describe('resolveThreadExecutionRoute', () => {
  beforeEach(() => {
    useGeneralSetting.setState({
      agentModeEnabled: true,
      legacyChatEngine: false,
    })
    selectLocalModel()
  })

  it('keeps a stored Agent mode on the chat pipeline while the mode is hidden', () => {
    platformFeatures.agentMode = false

    expect(resolveThreadExecutionRoute('thread-1')).toEqual({
      route: 'chat-transport',
      reason: 'default-chat',
    })
  })

  it('routes a stored Agent mode to the agent engine once the mode is shown', () => {
    platformFeatures.agentMode = true

    expect(resolveThreadExecutionRoute('thread-1')).toEqual({
      route: 'agent-ipc',
      reason: 'user-selected-agent',
    })
  })
})
