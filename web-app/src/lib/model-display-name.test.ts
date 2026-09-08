import { describe, expect, it } from 'vitest'
import { prettyModelName } from './model-display-name'

describe('prettyModelName', () => {
  it('drops the author, the format, the quantization and the tuning suffix', () => {
    expect(prettyModelName('unsloth/Llama-3.2-3B-Instruct-GGUF')).toBe(
      'Llama 3.2 3B'
    )
    expect(prettyModelName('mlx-community/gemma-4-e4b-it-4bit')).toBe(
      'Gemma 4 E4B'
    )
    expect(prettyModelName('Qwen3.5-4B-Instruct-Q4_K_M.gguf')).toBe(
      'Qwen3.5 4B'
    )
  })

  it('spells out compact family versions', () => {
    expect(prettyModelName('AtomicChat/qwen35-4b-GGUF')).toBe('Qwen3.5 4B')
    expect(prettyModelName('AtomicChat/qwen36-27b-GGUF')).toBe('Qwen3.6 27B')
    expect(prettyModelName('AtomicChat/qwen3-coder-30b-a3b-GGUF')).toBe(
      'Qwen3 Coder 30B A3B'
    )
  })

  it('keeps deliberate capitalization', () => {
    expect(prettyModelName('LiquidAI/LFM2.5-VL-450M-GGUF')).toBe(
      'LFM2.5 VL 450M'
    )
    expect(prettyModelName('AtomicChat/gemma-4-E2B-it-GGUF')).toBe(
      'Gemma 4 E2B'
    )
  })

  it('names every model onboarding offers', () => {
    // Every rung of `RECOMMENDATION_LADDER`, which is what the first screen
    // puts in front of a user who has never downloaded a local model.
    expect(prettyModelName('LiquidAI/LFM2.5-1.2B-Instruct-GGUF')).toBe(
      'LFM2.5 1.2B'
    )
    expect(prettyModelName('LiquidAI/LFM2.5-2.6B-GGUF')).toBe('LFM2.5 2.6B')
    expect(prettyModelName('AtomicChat/Qwen3.5-4B-GGUF')).toBe('Qwen3.5 4B')
    expect(prettyModelName('AtomicChat/Qwen3.5-9B-GGUF')).toBe('Qwen3.5 9B')
    expect(prettyModelName('AtomicChat/gemma-4-E4B-it-GGUF')).toBe(
      'Gemma 4 E4B'
    )
    // QAT is an acronym; without the casing entry this reads "Gemma 4 12B Qat".
    expect(prettyModelName('unsloth/gemma-4-12B-it-qat-GGUF')).toBe(
      'Gemma 4 12B QAT'
    )
  })

  it('never renders blank', () => {
    expect(prettyModelName('someone/GGUF')).toBe('GGUF')
    expect(prettyModelName('')).toBe('')
    expect(prettyModelName(undefined)).toBe('')
  })
})
