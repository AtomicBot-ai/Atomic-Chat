import { describe, expect, it } from 'vitest'

import { ENGINE_IDS, ENGINE_KINDS } from '../types'
import { ENGINE_UPDATE_ORDER } from '@/lib/engineUpdateOffer'

describe('vendored engine lists', () => {
  it('lists the engines in the core’s order, Foundry Local and LiteRT-LM engine builds after MLX', () => {
    expect([...ENGINE_IDS]).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'atomic-prism',
      'sd-cpp',
      'mlx',
      'foundry-local',
      'litert-lm',
      'tensorrt-llm',
      'vllm',
      'sglang',
    ])
    expect(ENGINE_KINDS['foundry-local']).toBe('engine-build')
  })

  it('lists LiteRT-LM as an engine build right after Foundry Local (change add-litert-lm-runtime)', () => {
    expect(ENGINE_IDS.indexOf('litert-lm')).toBe(ENGINE_IDS.indexOf('foundry-local') + 1)
    expect(ENGINE_KINDS['litert-lm']).toBe('engine-build')
  })

  it('offers a Foundry Local update in the engine banner’s order', () => {
    expect([...ENGINE_UPDATE_ORDER].sort()).toEqual([...ENGINE_IDS].sort())
  })
})
