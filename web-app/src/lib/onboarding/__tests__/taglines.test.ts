import { describe, expect, it } from 'vitest'

import type { CatalogModel } from '@/services/models/types'

import {
  baseModelKey,
  catalogTags,
  isFirstRunChatRepo,
  modelTagline,
} from '../taglines'

const repo = (model_name: string, tags: string[] = []): CatalogModel =>
  ({
    model_name,
    description: tags.length ? `**Tags**: ${tags.join(', ')}` : '',
    downloads: 0,
  }) as CatalogModel

describe('modelTagline', () => {
  it.each([
    ['unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', [], 'code'],
    ['bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', [], 'reasoning'],
    ['owao/Nanbeige4.2-3B-GGUF', ['tool-use'], 'agent'],
    ['Qwen/Qwen3-VL-8B-Instruct-GGUF', [], 'vision'],
    ['unsloth/gemma-4-12b-it-GGUF', ['image-text-to-text'], 'vision'],
    ['unsloth/Qwen3.6-35B-A3B-GGUF', [], 'sparse'],
    ['LiquidAI/LFM2.5-1.2B-Instruct-GGUF', [], 'small'],
    ['bartowski/SmolLM2-360M-Instruct-GGUF', [], 'small'],
    ['unsloth/Qwen3.8-27B-GGUF', [], 'large'],
    ['bartowski/Mistral-7B-Instruct-v0.3-GGUF', [], 'general'],
    ['google/gemma-4-E4B-it', [], 'general'],
  ])('%s reads as %s', (name, tags, expected) => {
    expect(modelTagline(name, tags)).toBe(expected)
  })

  it('does not take a version number for a parameter count', () => {
    expect(modelTagline('AtomicChat/Qwen3.5-4B-GGUF')).toBe('general')
  })
})

describe('catalog repos on the first run', () => {
  it('reads the tags out of the description', () => {
    expect(catalogTags(repo('a/b', ['GGUF', 'Conversational']))).toEqual([
      'gguf',
      'conversational',
    ])
    expect(catalogTags(repo('a/b'))).toEqual([])
  })

  it('keeps chat models and leaves out media, speech, embeddings and unfiltered builds', () => {
    const chat = ['gguf', 'conversational']
    expect(isFirstRunChatRepo(repo('unsloth/Qwen3.5-9B-GGUF', chat))).toBe(true)
    expect(
      isFirstRunChatRepo(repo('unsloth/Z-Image-Turbo-GGUF', ['text-to-image']))
    ).toBe(false)
    expect(
      isFirstRunChatRepo(
        repo('KittenML/kitten-tts-2', ['text-to-speech', 'conversational'])
      )
    ).toBe(false)
    expect(
      isFirstRunChatRepo(
        repo('nomic/nomic-embed-text-GGUF', ['feature-extraction'])
      )
    ).toBe(false)
    expect(
      isFirstRunChatRepo(repo('huihui-ai/Qwen3.8-27B-abliterated-GGUF', chat))
    ).toBe(false)
    expect(isFirstRunChatRepo(repo('someone/Mystery-GGUF', ['gguf']))).toBe(
      false
    )
  })

  it('counts the uploads of one model by several publishers once', () => {
    const tags = [
      'base_model:quantized:qwen/qwen3.8-27b',
      'base_model:qwen/qwen3.8-27b',
    ]
    expect(baseModelKey(repo('unsloth/Qwen3.8-27B-GGUF', tags))).toBe(
      'qwen/qwen3.8-27b'
    )
    expect(baseModelKey(repo('ggml-org/Qwen3.8-27B-GGUF', tags))).toBe(
      'qwen/qwen3.8-27b'
    )
    expect(baseModelKey(repo('bartowski/Phi-4-mini-GGUF'))).toBe('phi-4-mini')
  })
})
