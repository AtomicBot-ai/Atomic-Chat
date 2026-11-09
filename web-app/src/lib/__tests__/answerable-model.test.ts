import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODEL_ID } from '@/constants/models'

import { isAnswerableModel, isEmbeddingOnlyModel } from '../answerable-model'

describe('isAnswerableModel', () => {
  it('takes a downloaded chat model', () => {
    expect(isAnswerableModel({ id: 'unsloth/Qwen3_5-9B-IQ4_XS' })).toBe(true)
  })

  it('leaves out what cannot chat or cannot load', () => {
    expect(isAnswerableModel({})).toBe(false)
    expect(isAnswerableModel({ id: 'm', missing: true })).toBe(false)
    expect(isAnswerableModel({ id: EMBEDDING_MODEL_ID })).toBe(false)
    expect(isAnswerableModel({ id: 'bge-m3', embedding: true })).toBe(false)
    expect(
      isAnswerableModel({ id: 'bge-m3', capabilities: ['embeddings'] })
    ).toBe(false)
  })

  it('leaves out a decision GGUF, which the core refuses for chat', () => {
    expect(
      isAnswerableModel({
        id: 'turintech/d1-3B-Artemis-Q4_K_M',
        decision: true,
      })
    ).toBe(false)
    // It is not an embedding model either.
    expect(
      isEmbeddingOnlyModel({
        id: 'turintech/d1-3B-Artemis-Q4_K_M',
        decision: true,
      })
    ).toBe(false)
  })
})
