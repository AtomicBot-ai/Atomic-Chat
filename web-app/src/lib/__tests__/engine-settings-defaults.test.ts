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
