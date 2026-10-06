import { describe, expect, it } from 'vitest'

import {
  customEngineSettingKeys,
  hasEngineSettingDefaults,
  withDefaultEngineSettings,
} from '@/lib/engine-settings-defaults'

const setting = (key: string, value: unknown) =>
  ({
    key,
    title: key,
    description: '',
    controller_type: 'input',
    controller_props: { value, type: 'text' },
  }) as unknown as ProviderSetting

// What a user who tuned llama.cpp and then picked a backend and a GPU has.
const tuned = () => [
  setting('version_backend', 'b10809/macos-arm64'),
  setting('mtp', true),
  setting('concurrent_mode', false),
  setting('extra_args', '--no-warmup'),
  setting('timeout', '1800'),
  setting('threads', '8'),
  setting('device', 'Metal0'),
  setting('draft_model_path', '/models/draft.gguf'),
]

describe('customEngineSettingKeys', () => {
  it('lists the settings that are off their default', () => {
    expect(customEngineSettingKeys('llamacpp-upstream', tuned())).toEqual([
      'mtp',
      'extra_args',
      'threads',
    ])
  })

  it('ignores the backend, the GPU choice and settings without a default', () => {
    expect(
      customEngineSettingKeys('llamacpp-upstream', [
        setting('version_backend', 'b10809/macos-arm64'),
        setting('device', 'Metal0'),
        setting('draft_model_path', '/models/draft.gguf'),
      ])
    ).toEqual([])
  })

  it('has nothing to say about providers it has no defaults for', () => {
    expect(hasEngineSettingDefaults('openai')).toBe(false)
    expect(hasEngineSettingDefaults('toString')).toBe(false)
    expect(customEngineSettingKeys('openai', tuned())).toEqual([])
  })
})

describe('withDefaultEngineSettings', () => {
  it('puts every setting back on its default and keeps the rest', () => {
    const reset = withDefaultEngineSettings('llamacpp-upstream', tuned())
    const value = (key: string) =>
      reset.find((s) => s.key === key)?.controller_props.value

    expect(value('mtp')).toBe(false)
    expect(value('extra_args')).toBe('')
    expect(value('threads')).toBe(-1)
    expect(value('version_backend')).toBe('b10809/macos-arm64')
    expect(value('device')).toBe('Metal0')
    expect(value('draft_model_path')).toBe('/models/draft.gguf')
    expect(customEngineSettingKeys('llamacpp-upstream', reset)).toEqual([])
  })

  it('uses each engine its own defaults', () => {
    const [timeout] = withDefaultEngineSettings('mlx', [
      setting('timeout', 30),
    ])
    expect(timeout.controller_props.value).toBe(600)
  })
})

describe('TensorRT-LLM defaults', () => {
  it('resets to the core schema defaults, the card choice included', () => {
    // The card is picked on the provider's own page, not the Hardware page, so
    // unlike llama.cpp's `device` it goes back to "most free memory" ('').
    const settings = [
      setting('gpu_id', 'GPU-2'),
      setting('context_length', 32768),
      setting('kv_cache_free_gpu_memory_fraction', 0.8),
    ]

    expect(hasEngineSettingDefaults('tensorrt-llm')).toBe(true)
    expect(customEngineSettingKeys('tensorrt-llm', settings)).toEqual([
      'gpu_id',
      'context_length',
    ])
    expect(
      withDefaultEngineSettings('tensorrt-llm', settings).map(
        (s) => s.controller_props.value
      )
    ).toEqual(['', 8192, 0.8])
  })

  it('resets vLLM to its core schema defaults', () => {
    const settings = [setting('max_num_seqs', 2), setting('kv_cache_dtype', 'auto')]

    expect(hasEngineSettingDefaults('vllm')).toBe(true)
    expect(customEngineSettingKeys('vllm', settings)).toEqual(['max_num_seqs'])
    expect(
      withDefaultEngineSettings('vllm', settings).map((s) => s.controller_props.value)
    ).toEqual([1, 'auto'])
  })
})
