import { describe, it, expect, vi } from 'vitest'

// Build-time globals read at module scope by localScan (path separator, MLX
// gating) must exist before the module loads.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.IS_TAURI = false
  g.IS_MACOS = true
  g.IS_WINDOWS = false
  g.IS_LINUX = false
})

import { isTextGenerationGguf, isTextGenerationHfConfig } from '../localScan'

describe('isTextGenerationGguf', () => {
  it('keeps a plain decoder', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'qwen3',
        'qwen3.block_count': '28',
      })
    ).toBe(true)
  })

  it('rejects an encoder-only embedding backbone (bge / bert)', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'bert',
        'bert.pooling_type': '2',
      })
    ).toBe(false)
  })

  it('rejects an embedding conversion of a generative architecture', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'qwen3',
        'qwen3.pooling_type': '1',
      })
    ).toBe(false)
  })

  it('keeps a decoder that declares pooling type NONE', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'llama',
        'llama.pooling_type': '0',
      })
    ).toBe(true)
  })

  it('rejects a reranker classifier head', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'gemma3',
        'gemma3.classifier.output_labels': '[yes, no]',
      })
    ).toBe(false)
  })

  it('keeps a model with unknown or missing architecture', () => {
    expect(isTextGenerationGguf({})).toBe(true)
    expect(isTextGenerationGguf({ 'general.architecture': 'brand-new' })).toBe(
      true
    )
  })
})

describe('isTextGenerationHfConfig', () => {
  it('keeps a causal LM folder', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({
          architectures: ['Qwen3ForCausalLM'],
          model_type: 'qwen3',
        })
      )
    ).toBe(true)
  })

  it('rejects an encoder-only embedding folder', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({ architectures: ['BertModel'], model_type: 'bert' })
      )
    ).toBe(false)
  })

  it('rejects a sequence-classification head', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({
          architectures: ['XLMRobertaForSequenceClassification'],
        })
      )
    ).toBe(false)
  })

  it('keeps a folder with a missing or unreadable config', () => {
    expect(isTextGenerationHfConfig(null)).toBe(true)
    expect(isTextGenerationHfConfig('{ not json')).toBe(true)
    expect(isTextGenerationHfConfig('{}')).toBe(true)
  })
})
