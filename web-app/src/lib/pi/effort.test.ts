import { afterEach, expect, it } from 'vitest'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { piEffort } from './effort'

const original = useGeneralSetting.getState()
afterEach(() => useGeneralSetting.setState(original))

const model: Model = { id: 'test', reasoning: { supportsThinking: true } }

it('uses the saved slider position, including Off and Max, for a local task', () => {
  useGeneralSetting.setState({
    disableReasoning: true,
    reasoningBudget: 'medium',
  })
  const off = piEffort('llamacpp', model)
  expect(off.level).toBe('off')
  expect(off.fields.off).toEqual({
    chat_template_kwargs: { enable_thinking: false },
  })
  useGeneralSetting.setState({ disableReasoning: false })
  const medium = piEffort('llamacpp', model)
  expect(medium.level).toBe('medium')
  expect(medium.fields.medium).toEqual({ reasoning_budget_tokens: 1024 })
  useGeneralSetting.setState({ reasoningBudget: 'max' })
  const max = piEffort('llamacpp', model)
  expect(max.level).toBe('max')
  expect(typeof max.map.max).toBe('string')
  expect(max.fields.max).toEqual({})
})

it('uses only the effort values the selected model can express', () => {
  const restricted: Model = {
    ...model,
    reasoning: {
      supportsThinking: true,
      canDisable: false,
      effortKwarg: 'reasoning_effort',
      effortValues: ['low', 'high'],
    },
  }
  useGeneralSetting.setState({
    disableReasoning: true,
    reasoningBudget: 'medium',
  })
  const low = piEffort('mlx', restricted)
  expect(low.level).toBe('low')
  expect(low.map.off).toBeNull()
  expect(low.map.medium).toBeNull()
  expect(low.fields.low).toEqual({ reasoning_effort: 'low' })
  useGeneralSetting.setState({
    disableReasoning: false,
    reasoningBudget: 'max',
  })
  expect(piEffort('mlx', restricted).level).toBe('high')
  expect(
    piEffort('llamacpp', {
      id: 'non-thinking',
      reasoning: { supportsThinking: false },
    }).level
  ).toBe('off')
  expect(piEffort('strata', model).fields).toEqual({})
})

it('uses the remote provider’s native effort fields', () => {
  expect(piEffort('anthropic', model).fields.medium).toEqual({
    thinking: { type: 'enabled', budget_tokens: 4096 },
  })
  expect(piEffort('anthropic', model).fields.off).toEqual({
    thinking: { type: 'disabled' },
  })
  expect(piEffort('google', { id: 'gemini-2.5-flash' }).fields.off).toEqual({
    reasoning_effort: 'none',
  })
  expect(piEffort('openrouter', model).fields.medium).toEqual({
    reasoning: { effort: 'medium' },
  })
})
