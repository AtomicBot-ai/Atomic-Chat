import { describe, expect, it } from 'vitest'
import {
  checkGemmaMtpSupport,
  gemmaMtpDraftUrl,
  resolveGemmaMtpDraft,
} from './gemmaMtpRegistry'

describe('Gemma 4 MTP registry', () => {
  it('pairs the 26B-A4B MoE with the unsloth gemma4-assistant head', () => {
    const draft = resolveGemmaMtpDraft('unsloth/gemma-4-26B-A4B-it-GGUF-Q4_K_M')

    expect(draft?.repo).toBe('unsloth/gemma-4-26B-A4B-it-GGUF')
    expect(draft?.draftFilename).toBe('mtp-gemma-4-26B-A4B-it.gguf')
    expect(draft?.draftSha256).toBe(
      '6326fb9f5e487aa8dcdd313a091e3c67724cb2a666ec3b7d2895b5b26d93ed1b'
    )
    expect(draft?.draftSize).toBe(461766816)
    expect(gemmaMtpDraftUrl(draft!)).toBe(
      'https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/mtp-gemma-4-26B-A4B-it.gguf'
    )
  })

  it('pairs the 31B dense model with the reference head', () => {
    expect(resolveGemmaMtpDraft('gemma-4-31B-it-Q4_K_M')?.repo).toBe(
      'am17an/Gemma4-31B-it-GGUF'
    )
  })

  it('offers no head for sizes upstream does not support', () => {
    expect(checkGemmaMtpSupport('gemma-4-E4B-it-Q4_K_M')).toBe(false)
    expect(checkGemmaMtpSupport('gemma-4-12B-it-Q4_K_M')).toBe(false)
  })
})
