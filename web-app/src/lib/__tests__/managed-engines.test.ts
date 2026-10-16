import { describe, expect, it } from 'vitest'

import {
  isManagedProvider,
  managedEngine,
  managedEngines,
  providerKey,
  hubKey,
} from '../managed-engines'

describe('the managed engine registry', () => {
  it('lists vLLM, SGLang, TensorRT-LLM: every list of managed engines shows them in this order', () => {
    // spec vllm-desktop: in provider lists, formats and verdicts vLLM comes first; spec
    // sglang-desktop "Порядок трёх движков": SGLang between vLLM and TensorRT-LLM.
    expect(managedEngines().map((engine) => engine.id)).toEqual(['vllm', 'sglang', 'tensorrt-llm'])
  })

  it('knows each engine by its provider id, with its own name and locale block', () => {
    expect(managedEngine('vllm')).toEqual({ id: 'vllm', label: 'vLLM', i18n: 'vllm' })
    expect(managedEngine('tensorrt-llm')?.i18n).toBe('tensorrt')
    expect(managedEngine('sglang')).toEqual({ id: 'sglang', label: 'SGLang', i18n: 'sglang' })
    expect(providerKey(managedEngine('vllm')!)('install')).toBe('providers:vllm.install')
    expect(hubKey(managedEngine('tensorrt-llm')!)('installEngine')).toBe('hub:tensorrt.installEngine')
  })

  it('is no other provider', () => {
    for (const other of ['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models', 'openai', undefined]) {
      expect(isManagedProvider(other)).toBe(false)
    }
    expect(isManagedProvider('vllm')).toBe(true)
    expect(isManagedProvider('sglang')).toBe(true)
  })
})
