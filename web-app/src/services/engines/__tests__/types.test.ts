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
      'audio-cpp',
      'mlx',
      'foundry-local',
      'litert-lm',
      'geniex',
      'fastflowlm',
      'tensorrt-llm',
      'vllm',
      'sglang',
    ])
    expect(ENGINE_KINDS['foundry-local']).toBe('engine-build')
  })

  it('lists audio.cpp as an engine build right after sd.cpp, in the banner’s order too', () => {
    expect(ENGINE_IDS.indexOf('audio-cpp')).toBe(ENGINE_IDS.indexOf('sd-cpp') + 1)
    expect(ENGINE_KINDS['audio-cpp']).toBe('engine-build')
    expect(ENGINE_UPDATE_ORDER.indexOf('audio-cpp')).toBe(ENGINE_UPDATE_ORDER.indexOf('sd-cpp') + 1)
  })

  it('lists LiteRT-LM as an engine build right after Foundry Local (change add-litert-lm-runtime)', () => {
    expect(ENGINE_IDS.indexOf('litert-lm')).toBe(ENGINE_IDS.indexOf('foundry-local') + 1)
    expect(ENGINE_KINDS['litert-lm']).toBe('engine-build')
  })

  it('lists GenieX as an engine build right after LiteRT-LM (change add-geniex-runtime)', () => {
    expect(ENGINE_IDS.indexOf('geniex')).toBe(ENGINE_IDS.indexOf('litert-lm') + 1)
    expect(ENGINE_KINDS['geniex']).toBe('engine-build')
    expect(ENGINE_UPDATE_ORDER.indexOf('geniex')).toBe(ENGINE_UPDATE_ORDER.indexOf('litert-lm') + 1)
  })

  it('lists FastFlowLM as an engine build right after GenieX, in the banner’s order too', () => {
    expect(ENGINE_IDS.indexOf('fastflowlm')).toBe(ENGINE_IDS.indexOf('geniex') + 1)
    expect(ENGINE_KINDS['fastflowlm']).toBe('engine-build')
    expect(ENGINE_UPDATE_ORDER.indexOf('fastflowlm')).toBe(ENGINE_UPDATE_ORDER.indexOf('geniex') + 1)
  })

  it('offers a Foundry Local update in the engine banner’s order', () => {
    expect([...ENGINE_UPDATE_ORDER].sort()).toEqual([...ENGINE_IDS].sort())
  })
})
