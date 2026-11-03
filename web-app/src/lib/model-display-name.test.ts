import { describe, expect, it } from 'vitest'
import {
  compactModelDisplayName,
  modelVariantDetails,
  prettyModelName,
  qualifiedModelDisplayName,
} from './model-display-name'

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

  it('reads a repo name glued to its file name once', () => {
    expect(prettyModelName('unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS')).toBe(
      'Qwen3.5 9B'
    )
    expect(
      prettyModelName(
        'unsloth/Qwen3_5-35B-A3B-Instruct-GGUF-Qwen3_5-35B-A3B-Q4_K_M'
      )
    ).toBe('Qwen3.5 35B A3B')
    expect(prettyModelName('prism-ml/Ternary-Bonsai-1.7B-PQ2_0.gguf')).toBe(
      'Ternary Bonsai 1.7B'
    )
  })

  it('never renders blank', () => {
    expect(prettyModelName('someone/GGUF')).toBe('GGUF')
    expect(prettyModelName('')).toBe('')
    expect(prettyModelName(undefined)).toBe('')
  })
})

describe('compactModelDisplayName', () => {
  const technical = 'mradermacher/Huihui-Ornith-1_5-9B-abliterated_i1-IQ4_XS'

  it('removes the repository owner and quantization from local model ids', () => {
    expect(compactModelDisplayName({ id: technical } as Model)).toBe(
      'Huihui Ornith 1.5 9B Abliterated'
    )
  })

  it('keeps an explicit user display name', () => {
    expect(
      compactModelDisplayName({
        id: technical,
        displayName: 'My Ornith',
      } as Model)
    ).toBe('My Ornith')
  })
})

describe('qualifiedModelDisplayName', () => {
  it('keeps the author namespace and the quant while cleaning the filename', () => {
    expect(
      qualifiedModelDisplayName({
        id: 'LiquidAI/LFM2.5-2.6B-Q4_K_M',
      } as Model)
    ).toBe('LiquidAI/LFM2.5 2.6B Q4_K_M')
  })

  // QA on 2.2.21: the picker read "unsloth/Qwen3.5 9B Qwen3.5 9B" for both
  // quants of the repo, and "prism-ml/prism-ml/Ternary Bonsai 1.7B P…".
  it('names a repo glued to its file once, with the quant that tells them apart', () => {
    const iq4 = { id: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS' } as Model
    const q4 = { id: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-Q4_K_M' } as Model

    expect(qualifiedModelDisplayName(iq4)).toBe('unsloth/Qwen3.5 9B IQ4_XS')
    expect(qualifiedModelDisplayName(q4)).toBe('unsloth/Qwen3.5 9B Q4_K_M')
    expect(compactModelDisplayName(iq4)).toBe('Qwen3.5 9B')
  })

  it('shows a repeated namespace once and keeps the PrismML quant', () => {
    for (const id of [
      'prism-ml/prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
      'prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
    ]) {
      expect(qualifiedModelDisplayName({ id } as Model)).toBe(
        'prism-ml/Ternary Bonsai 1.7B PQ2_0'
      )
      expect(compactModelDisplayName({ id } as Model)).toBe(
        'Ternary Bonsai 1.7B'
      )
    }
    expect(
      qualifiedModelDisplayName({
        id: 'prism-ml/Ternary-Bonsai-1_7B-Q2_0_g64',
      } as Model)
    ).toBe('prism-ml/Ternary Bonsai 1.7B Q2_0_g64')
  })

  it('does not repeat a namespace the nickname already starts with', () => {
    expect(
      qualifiedModelDisplayName({
        id: 'prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
        displayName: 'prism-ml/Ternary Bonsai',
      } as Model)
    ).toBe('prism-ml/Ternary Bonsai')
  })

  it('takes the last marker as the quant', () => {
    expect(
      qualifiedModelDisplayName({
        id: 'mradermacher/Huihui-Ornith-1_5-9B-abliterated_i1-IQ4_XS',
      } as Model)
    ).toBe('mradermacher/Huihui Ornith 1.5 9B Abliterated IQ4_XS')
    expect(
      qualifiedModelDisplayName({ id: 'author/Model-Name' } as Model)
    ).toBe('author/Model Name')
  })

  it('uses a nickname after the namespace and leaves unqualified ids alone', () => {
    expect(
      qualifiedModelDisplayName({
        id: 'author/model-Q4_K_M.gguf',
        displayName: 'My Model',
      } as Model)
    ).toBe('author/My Model')
    expect(
      qualifiedModelDisplayName({ id: 'model-Q4_K_M.gguf' } as Model)
    ).toBe('Model Q4_K_M')
  })
})

// QA 09 (2.2.23): the picker names a row once and puts these under the name.
describe('modelVariantDetails', () => {
  it('gives the quant as spelled and the owner of a namespaced id', () => {
    expect(
      modelVariantDetails({
        id: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS',
      } as Model)
    ).toEqual({ quant: 'IQ4_XS', owner: 'unsloth' })
    expect(
      modelVariantDetails({
        id: 'ollama/gemma-4-12b-uncensored-heretic-q4_K_M',
      } as Model)
    ).toEqual({ quant: 'q4_K_M', owner: 'ollama' })
    expect(
      modelVariantDetails({
        id: 'prism-ml/prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
      } as Model)
    ).toEqual({ quant: 'PQ2_0', owner: 'prism-ml' })
  })

  it('names the owner, not the whole repo path, of a cached Hugging Face file', () => {
    expect(
      modelVariantDetails({
        id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K',
      } as Model)
    ).toEqual({ quant: 'Q6_K', owner: 'lmstudio-community' })
  })

  it('leaves out what the id does not carry', () => {
    expect(
      modelVariantDetails({ id: 'gemma-4-E4B-it-IQ4_XS' } as Model)
    ).toEqual({ quant: 'IQ4_XS', owner: undefined })
    expect(
      modelVariantDetails({ id: 'ollama/heretic-12b-latest' } as Model)
    ).toEqual({ quant: undefined, owner: 'ollama' })
    expect(modelVariantDetails({ id: 'gpt-4.1' } as Model)).toEqual({
      quant: undefined,
      owner: undefined,
    })
  })

  it('does not repeat what a nickname already reads', () => {
    expect(
      modelVariantDetails({
        id: 'ollama/gemma-4-12b-q4_K_M',
        displayName: 'gemma-4-12b:q4_K_M',
      } as Model)
    ).toEqual({ quant: undefined, owner: 'ollama' })
    expect(
      modelVariantDetails({
        id: 'prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
        displayName: 'prism-ml/Ternary Bonsai',
      } as Model)
    ).toEqual({ quant: 'PQ2_0', owner: undefined })
  })
})
