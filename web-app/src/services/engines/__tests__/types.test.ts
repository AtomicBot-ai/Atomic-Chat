import { describe, expect, it } from 'vitest'

import { ENGINE_IDS, ENGINE_KINDS } from '../types'
import { ENGINE_UPDATE_ORDER } from '@/lib/engineUpdateOffer'

describe('vendored engine lists', () => {
  it('lists the engines in the core’s order, Foundry Local an engine build after MLX', () => {
    expect([...ENGINE_IDS]).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'atomic-prism',
      'sd-cpp',
      'mlx',
      'foundry-local',
      'tensorrt-llm',
      'vllm',
      'sglang',
    ])
    expect(ENGINE_KINDS['foundry-local']).toBe('engine-build')
  })

  it('offers a Foundry Local update in the engine banner’s order', () => {
    expect([...ENGINE_UPDATE_ORDER].sort()).toEqual([...ENGINE_IDS].sort())
  })
})
