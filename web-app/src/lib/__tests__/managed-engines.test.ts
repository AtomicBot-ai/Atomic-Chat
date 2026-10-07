import { describe, expect, it } from 'vitest'

import {
  isManagedProvider,
  managedEngine,
  managedEngines,
  providerKey,
  hubKey,
} from '../managed-engines'

describe('the managed engine registry', () => {
  it('lists vLLM before TensorRT-LLM: every list of managed engines shows them in this order', () => {
    // spec vllm-desktop: in provider lists, formats and verdicts vLLM comes first.
    expect(managedEngines().map((engine) => engine.id)).toEqual(['vllm', 'tensorrt-llm'])
  })

  it('knows each engine by its provider id, with its own name and locale block', () => {
    expect(managedEngine('vllm')).toEqual({ id: 'vllm', label: 'vLLM', i18n: 'vllm' })
    expect(managedEngine('tensorrt-llm')?.i18n).toBe('tensorrt')
    expect(providerKey(managedEngine('vllm')!)('install')).toBe('providers:vllm.install')
    expect(hubKey(managedEngine('tensorrt-llm')!)('installEngine')).toBe('hub:tensorrt.installEngine')
  })

  it('is no other provider', () => {
    for (const other of ['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models', 'openai', undefined]) {
      expect(isManagedProvider(other)).toBe(false)
    }
    expect(isManagedProvider('vllm')).toBe(true)
  })
})
