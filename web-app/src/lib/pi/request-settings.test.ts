import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import register from '../../../../src-tauri/src/core/pi_agent/extension/atomic-approval'

const scratch = mkdtempSync(join(tmpdir(), 'atomic-pi-settings-'))
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

it('applies the assistant prompt and sampling to the provider payload while preserving pi tools and streaming', () => {
  const file = join(scratch, 'integrations.json')
  writeFileSync(
    file,
    JSON.stringify({
      skills: [],
      tools: [],
      assistantInstructions: 'Use the project glossary.',
      sampling: { temperature: 0, top_p: 0.9, top_k: 25, repeat_penalty: 1.12 },
      reasoningFields: {
        off: { chat_template_kwargs: { enable_thinking: false } },
        medium: { reasoning_budget_tokens: 1024 },
      },
    })
  )
  vi.stubEnv('ATOMIC_PI_INTEGRATIONS', file)
  const on = vi.fn()
  const getThinkingLevel = vi.fn(() => 'off')
  register({ on, getThinkingLevel } as unknown as Parameters<
    typeof register
  >[0])
  const hook = (name: string) =>
    on.mock.calls.find(([event]) => event === name)![1]
  const prompt = hook('before_agent_start')({
    systemPrompt: 'pi system',
  }).systemPrompt
  expect(prompt).toContain('pi system')
  expect(prompt).toContain('Use the project glossary.')
  const payload = {
    model: 'test',
    stream: true,
    temperature: 1,
    chat_template_kwargs: { enable_thinking: true, language: 'en' },
    messages: [{ role: 'user', content: 'Read' }],
    tools: [{ name: 'read' }],
  }
  expect(hook('before_provider_request')({ payload })).toEqual({
    ...payload,
    temperature: 0,
    top_p: 0.9,
    top_k: 25,
    repeat_penalty: 1.12,
    chat_template_kwargs: { enable_thinking: false, language: 'en' },
  })
  getThinkingLevel.mockReturnValue('medium')
  expect(hook('before_provider_request')({ payload })).toMatchObject({
    chat_template_kwargs: payload.chat_template_kwargs,
    reasoning_budget_tokens: 1024,
  })
})
