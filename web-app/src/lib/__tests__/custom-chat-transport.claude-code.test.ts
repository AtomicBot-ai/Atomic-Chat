import { beforeEach, expect, it, vi } from 'vitest'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'
import * as claude from '../claude-code-chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
const request = {
  chatId: 'chat-cli',
  messages: [
    {
      id: 'user',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'hello' }],
    },
  ],
  abortSignal: undefined,
  trigger: 'submit-message' as const,
  messageId: undefined,
}
beforeEach(() => {
  vi.restoreAllMocks()
  seedServiceHub()
  useModelProvider.setState({
    providers: [
      claude.claudeCodeProvider([
        {
          id: 'claude-code-default',
          model: 'claude-opus-5-5[1m]',
          name: 'Claude Opus 5.5',
        },
      ]),
    ],
    selectedProvider: 'claude-code',
    selectedModel: { id: 'claude-code-default', model: 'claude-opus-5-5[1m]' },
  })
})
it('sends the resolved model to the CLI without constructing an HTTP model', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
  const bridge = vi.spyOn(claude, 'streamClaudeCode').mockResolvedValue(stream)
  const api = vi.spyOn(ModelFactory, 'createModel')
  const transport = new CustomChatTransport('Custom instructions', 'thread-cli')
  expect(await transport.sendMessages(request)).toBe(stream)
  expect(bridge).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: 'thread-cli',
      model: 'claude-opus-5-5[1m]',
      system: 'Custom instructions',
    })
  )
  expect(api).not.toHaveBeenCalled()
})
it('rejects disabled connections, missing models, and partial continuations', async () => {
  const transport = new CustomChatTransport()
  useModelProvider.setState({ selectedModel: null })
  await expect(transport.sendMessages(request)).rejects.toThrow(
    'enabled Claude'
  )
  useModelProvider.setState({ selectedModel: { id: 'claude-code-default' } })
  transport.setContinueFromContent('unfinished')
  await expect(transport.sendMessages(request)).rejects.toThrow(
    'partial response'
  )
  useModelProvider.getState().updateProvider('claude-code', { active: false })
  expect(useModelProvider.getState().selectedModel).toBeNull()
  await expect(transport.sendMessages(request)).rejects.toThrow(
    'model/provider missing'
  )
})
