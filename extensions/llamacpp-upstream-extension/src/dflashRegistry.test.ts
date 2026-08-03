import { describe, expect, it } from 'vitest'
import {
  checkDflashSupport,
  listDflashDrafts,
  resolveDflashDraft,
} from './dflashRegistry'

describe('DFlash registry', () => {
  it('defaults to Atomic Chat Q8_0 across target quantizations', () => {
    const draft = resolveDflashDraft(
      'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS'
    )

    expect(draft?.repo).toBe('AtomicChat/Qwen3.5-9B-DFlash-GGUF')
    expect(draft?.quant).toBe('Q8_0')
    expect(draft?.draftFilename).toBe('Qwen3.5-9B-DFlash.Q8_0.gguf')
  })

  it('lists every published compatible draft quantization', () => {
    expect(listDflashDrafts('Qwen3.5-9B-Instruct')).toHaveLength(5)
    expect(listDflashDrafts('Qwen3.6-27B-Instruct').map((draft) => draft.quant)).toEqual([
      'IQ4_XS',
      'Q4_K_M',
      'Q5_K_M',
      'Q6_K',
      'Q8_0',
      'F16',
    ])
    expect(listDflashDrafts('Qwen3.6-35B-A3B-Instruct')).toHaveLength(6)
  })

  it('resolves a specifically selected quantization', () => {
    const draft = resolveDflashDraft('Qwen3.5-9B-Instruct', 'Q8_0')

    expect(draft?.repo).toBe('AtomicChat/Qwen3.5-9B-DFlash-GGUF')
    expect(draft?.draftFilename).toBe('Qwen3.5-9B-DFlash.Q8_0.gguf')
    expect(draft?.draftSize).toBe(1383768224)
  })

  it('matches supported Qwen families across common separators', () => {
    expect(checkDflashSupport('Qwen3-4B-Instruct-Q4_K_M')).toBe(true)
    expect(checkDflashSupport('Qwen3_8B-Q4_K_M')).toBe(true)
    expect(checkDflashSupport('Qwen3.5-4B-Instruct-Q4_K_M')).toBe(true)
    expect(checkDflashSupport('Qwen3.5-9B-Instruct-Q4_K_M')).toBe(true)
    expect(checkDflashSupport('Qwen35-9B-IQ4_XS')).toBe(true)
    expect(checkDflashSupport('Qwen3_5-27B-IQ4_XS')).toBe(true)
    expect(checkDflashSupport('Qwen3_6-27B-Q4_K_M')).toBe(true)
    expect(checkDflashSupport('Qwen3-6-35B-A3B-IQ4_XS')).toBe(true)
    expect(checkDflashSupport('Qwen3-Coder-30B-A3B-Instruct')).toBe(true)
    expect(checkDflashSupport('Qwen3-Coder-Next-GGUF')).toBe(true)
  })

  it('uses Atomic Chat Q8_0 drafts when published', () => {
    const expectedRepos = new Map([
      ['Qwen3-4B-Instruct', 'AtomicChat/Qwen3-4B-DFlash-GGUF'],
      ['Qwen3-8B-Instruct', 'AtomicChat/Qwen3-8B-DFlash-GGUF'],
      ['Qwen3.5-4B-Instruct', 'AtomicChat/Qwen3.5-4B-DFlash-GGUF'],
      ['Qwen3.5-9B-Instruct', 'AtomicChat/Qwen3.5-9B-DFlash-GGUF'],
      ['Qwen3.5-27B-Instruct', 'AtomicChat/Qwen3.5-27B-DFlash-GGUF'],
      ['Qwen3.6-27B-Instruct', 'AtomicChat/Qwen3.6-27B-DFlash-GGUF'],
      [
        'Qwen3-Coder-30B-A3B-Instruct',
        'AtomicChat/Qwen3-Coder-30B-A3B-DFlash-GGUF',
      ],
      [
        'Qwen3-Coder-Next-Instruct',
        'AtomicChat/Qwen3-Coder-Next-DFlash-GGUF',
      ],
    ])

    for (const [modelId, repo] of expectedRepos) {
      const draft = resolveDflashDraft(modelId, 'Q8_0')
      expect(draft?.repo).toBe(repo)
      expect(draft?.draftSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(draft?.draftSize).toBeGreaterThan(0)
    }
  })

  it('falls back to the only published quant for Q8_0-only families', () => {
    expect(resolveDflashDraft('Qwen3-4B-Instruct')?.quant).toBe('Q8_0')
    expect(resolveDflashDraft('Qwen3-Coder-Next-Instruct')?.quant).toBe(
      'Q8_0'
    )
  })

  it('uses mainline llama.cpp DFlash GGUF repositories', () => {
    expect(resolveDflashDraft('Qwen3.6-27B-Q4_K_M', 'Q4_K_M')?.repo).toBe(
      'williamliao/qwen3.6-27B-DFlash-GGUF'
    )
    expect(
      resolveDflashDraft('Qwen3.6-35B-A3B-Q4_K_M', 'Q4_K_M')?.repo
    ).toBe(
      'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF'
    )
  })

  it('does not match unsupported Qwen sizes', () => {
    expect(checkDflashSupport('Qwen3_5-14B-IQ4_XS')).toBe(false)
    expect(checkDflashSupport('Qwen3_6-30B-A3B-IQ4_XS')).toBe(false)
    expect(checkDflashSupport('Qwen3-14B-Instruct')).toBe(false)
  })
})
