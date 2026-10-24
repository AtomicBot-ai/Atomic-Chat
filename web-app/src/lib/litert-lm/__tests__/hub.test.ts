import { describe, expect, it } from 'vitest'

import {
  curatedLiteRtLmCard,
  hfLiteRtLmCard,
  liteRtLmMatches,
  liteRtLmOf,
} from '../hub'
import { hubModelFacts } from '@/lib/hub-model-facts'
import { modelEngineIds } from '@/lib/hub-model-engines'
import { modelFormat } from '@/lib/model-card'
import type { LiteRtLmModel } from '@/services/litert-lm/curated'
import type { LiteRtLmHfModel } from '@/services/litert-lm/huggingface'

const curated: LiteRtLmModel = {
  id: 'gemma-4-e4b',
  name: 'Gemma 4 E4B',
  description: 'Gemma 4 for on-device use',
  task: 'chat',
  license: 'apache-2.0',
  repo: 'litert-community/gemma-4-E4B-it-litert-lm',
  revision: 'a'.repeat(40),
  gated: false,
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  variants: [
    {
      id: 'gemma-4-e4b-gpu',
      backend: 'gpu',
      platforms: ['macos-arm64', 'win-x64'],
      file: { path: 'gemma-4-E4B-it.litertlm', size: 3_650_000_000, sha256: 'b'.repeat(64) },
    },
  ],
}

const hf: LiteRtLmHfModel = {
  repo: 'litert-community/Qwen3-4B',
  name: 'Qwen3-4B',
  revision: 'c'.repeat(40),
  gated: true,
  license: 'apache-2.0',
  variants: [
    {
      id: 'qwen3_4b_mixed_int4-cpu',
      backend: 'cpu',
      platforms: ['macos-arm64'],
      file: { path: 'qwen3_4b_mixed_int4.litertlm', size: 2_659_053_760, sha256: 'd'.repeat(64) },
    },
  ],
}

describe('LiteRT-LM Hub entries', () => {
  it('shapes a curated model as a Hub entry of its own format and engine', () => {
    const card = curatedLiteRtLmCard(curated)

    expect(card.model_name).toBe('litert-lm/gemma-4-e4b')
    expect(liteRtLmOf(card)).toMatchObject({
      origin: 'curated',
      model_id: 'gemma-4-e4b',
      name: 'Gemma 4 E4B',
      repo: 'litert-community/gemma-4-E4B-it-litert-lm',
      tools: true,
      vision: true,
    })
    expect(modelFormat(card)).toBe('litert-lm')
    expect(modelEngineIds(card)).toEqual(['litert-lm'])
    const facts = hubModelFacts(card, { budgetBytes: 16e9 })
    expect(facts.fit).toBeUndefined()
    expect(facts.capabilities.map((capability) => capability.label)).toEqual(['Vision', 'Tool Use', 'Reasoning'])
  })

  it('shapes a Hugging Face model with what is known before download', () => {
    const card = hfLiteRtLmCard(hf)

    expect(card.model_name).toBe('litert-lm/litert-community/Qwen3-4B')
    expect(liteRtLmOf(card)).toMatchObject({
      origin: 'huggingface',
      model_id: 'litert-community/Qwen3-4B',
      name: 'Qwen3-4B',
      gated: true,
    })
    expect(liteRtLmOf(card)?.tools).toBeUndefined()
    expect(hubModelFacts(card, { budgetBytes: 16e9 }).capabilities).toEqual([])
  })

  it('matches a search in the id, name or summary, every word', () => {
    const card = curatedLiteRtLmCard(curated)
    expect(liteRtLmMatches(card, 'gemma E4B')).toBe(true)
    expect(liteRtLmMatches(card, 'on-device')).toBe(true)
    expect(liteRtLmMatches(card, 'qwen')).toBe(false)
    expect(liteRtLmMatches(card, '')).toBe(true)
  })

  it('is no LiteRT-LM entry for another Hub entry', () => {
    expect(liteRtLmOf({ model_name: 'unsloth/x', description: '', downloads: 0 })).toBeUndefined()
  })
})
