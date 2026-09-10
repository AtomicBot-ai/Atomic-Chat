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

import {
  gpt4allRoots,
  hfCacheRoots,
  isTextGenerationGguf,
  isTextGenerationHfConfig,
  janRoots,
  llamaCppCacheRoots,
  mstyRoots,
  ollamaRoot,
  unslothRoot,
} from '../localScan'

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

describe('where each app keeps its models', () => {
  const home = '/Users/me'

  it('honours the environment override first and keeps the default too', () => {
    // A user who moved the store to a second disk and still has files at the
    // default location sees both; the override was invisible before ATO-458.
    expect(ollamaRoot(home, { OLLAMA_MODELS: '/mnt/models/ollama' })).toBe(
      '/mnt/models/ollama'
    )
    expect(ollamaRoot(home, {})).toBe('/Users/me/.ollama/models')

    expect(unslothRoot(home, { UNSLOTH_STUDIO_HOME: '/srv/unsloth' })).toBe(
      '/srv/unsloth'
    )
    expect(unslothRoot(home, { STUDIO_HOME: '/srv/studio' })).toBe('/srv/studio')
    expect(unslothRoot(home, {})).toBe('/Users/me/.unsloth/studio')
  })

  it('reads every spelling of the Hugging Face cache location', () => {
    expect(
      hfCacheRoots(home, {
        HF_HUB_CACHE: '/mnt/hf/hub',
        HF_HOME: '/mnt/hf-home',
        TRANSFORMERS_CACHE: '/mnt/legacy',
      })
    ).toEqual([
      '/mnt/hf/hub',
      '/mnt/hf-home/hub',
      '/mnt/legacy',
      '/Users/me/.cache/huggingface/hub',
    ])
    expect(hfCacheRoots(home, {})).toEqual([
      '/Users/me/.cache/huggingface/hub',
    ])
  })

  it('does not list the same root twice', () => {
    expect(
      hfCacheRoots(home, { HF_HUB_CACHE: '/Users/me/.cache/huggingface/hub' })
    ).toHaveLength(1)
  })

  it('places the app-data stores per OS', () => {
    expect(gpt4allRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Application Support/nomic.ai/GPT4All',
    ])
    expect(gpt4allRoots(home, {}, 'linux')).toEqual([
      '/Users/me/.local/share/nomic.ai/GPT4All',
    ])
    expect(
      gpt4allRoots(home, { XDG_DATA_HOME: '/data/xdg' }, 'linux')
    ).toEqual(['/data/xdg/nomic.ai/GPT4All'])

    expect(mstyRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Application Support/Msty/models',
    ])
    expect(mstyRoots(home, {}, 'linux')).toEqual(['/Users/me/.config/Msty/models'])
  })

  it('checks both the default Jan data folder and the app-data one', () => {
    expect(janRoots(home, {}, 'macos')).toEqual([
      '/Users/me/jan/models',
      '/Users/me/Library/Application Support/Jan/data/models',
    ])
  })

  it("finds llama.cpp's own -hf cache, and LLAMA_CACHE when set", () => {
    expect(llamaCppCacheRoots(home, {}, 'linux')).toEqual([
      '/Users/me/.cache/llama.cpp',
    ])
    expect(
      llamaCppCacheRoots(home, { LLAMA_CACHE: '/fast/llama' }, 'linux')
    ).toEqual(['/fast/llama', '/Users/me/.cache/llama.cpp'])
    expect(llamaCppCacheRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Caches/llama.cpp',
      '/Users/me/.cache/llama.cpp',
    ])
  })

  it('uses %LOCALAPPDATA% / %APPDATA% on Windows when they are set', () => {
    // The scanner runs with the host separator; these tests pin `/`, so the
    // assertion is on the segments rather than the joined string.
    const env = {
      LOCALAPPDATA: 'C:/Users/me/AppData/Local',
      APPDATA: 'C:/Users/me/AppData/Roaming',
    }
    expect(gpt4allRoots('C:/Users/me', env, 'windows')[0]).toContain(
      'AppData/Local/nomic.ai/GPT4All'
    )
    expect(mstyRoots('C:/Users/me', env, 'windows')[0]).toContain(
      'AppData/Roaming/Msty/models'
    )
    expect(llamaCppCacheRoots('C:/Users/me', env, 'windows')).toEqual([
      'C:/Users/me/AppData/Local/llama.cpp',
    ])
  })
})
