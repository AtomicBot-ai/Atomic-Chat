import { describe, it, expect } from 'vitest'
import { normalizeBaseId, resolveDflashDraft } from './dflashRegistry'
import { resolveMtpDraft } from './mtpRegistry'
import { resolveEagle3Draft } from './eagle3Registry'

describe('normalizeBaseId', () => {
  it('strips standard quant suffixes', () => {
    expect(normalizeBaseId('mlx-community/Qwen3.5-4B-4bit')).toBe('qwen3.5-4b')
    expect(normalizeBaseId('mlx-community/Qwen3.5-4B-8bit')).toBe('qwen3.5-4b')
    expect(normalizeBaseId('mlx-community/Qwen3.5-9B-MLX-bf16')).toBe(
      'qwen3.5-9b'
    )
    expect(normalizeBaseId('mlx-community/gemma-4-E4B-it-4bit')).toBe(
      'gemma-4-e4b'
    )
  })

  it('strips -qat suffix (ATO-235: QAT models not found in registry)', () => {
    // Primary bug report: gemma-4-E4B-it-qat-4bit should normalize to gemma-4-e4b
    expect(normalizeBaseId('mlx-community/gemma-4-E4B-it-qat-4bit')).toBe(
      'gemma-4-e4b'
    )
    expect(normalizeBaseId('mlx-community/gemma-4-E2B-it-qat-4bit')).toBe(
      'gemma-4-e2b'
    )
    expect(normalizeBaseId('mlx-community/gemma-4-26B-A4B-it-qat-4bit')).toBe(
      'gemma-4-26b-a4b'
    )
    expect(normalizeBaseId('mlx-community/gemma-4-31B-it-qat-4bit')).toBe(
      'gemma-4-31b'
    )
  })

  it('strips bare -qat with no trailing quant type', () => {
    expect(normalizeBaseId('mlx-community/gemma-4-E4B-it-qat')).toBe(
      'gemma-4-e4b'
    )
  })

  it('strips -unquantized suffix', () => {
    expect(
      normalizeBaseId('mlx-community/gemma-4-E4B-it-unquantized')
    ).toBe('gemma-4-e4b')
  })

  it('handles qat with various quant bit-depths', () => {
    expect(normalizeBaseId('mlx-community/gemma-4-E4B-it-qat-8bit')).toBe(
      'gemma-4-e4b'
    )
    expect(normalizeBaseId('mlx-community/gemma-4-E4B-it-qat-6bit')).toBe(
      'gemma-4-e4b'
    )
    expect(normalizeBaseId('mlx-community/Qwen3.6-27B-qat-4bit')).toBe(
      'qwen3.6-27b'
    )
  })

  it('works without org prefix', () => {
    expect(normalizeBaseId('gemma-4-E4B-it-qat-4bit')).toBe('gemma-4-e4b')
    expect(normalizeBaseId('gpt-oss-20b')).toBe('gpt-oss-20b')
  })
})

describe('resolveMtpDraft with QAT targets (ATO-235)', () => {
  it('resolves gemma-4-E4B QAT target to its MTP assistant', () => {
    const result = resolveMtpDraft('mlx-community/gemma-4-E4B-it-qat-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('mlx-community/gemma-4-E4B-it-assistant-bf16')
  })

  it('resolves gemma-4-E2B QAT target to its MTP assistant', () => {
    const result = resolveMtpDraft('mlx-community/gemma-4-E2B-it-qat-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('mlx-community/gemma-4-E2B-it-assistant-bf16')
  })

  it('resolves gemma-4-26B-A4B QAT target to its MTP assistant', () => {
    const result = resolveMtpDraft(
      'mlx-community/gemma-4-26B-A4B-it-qat-4bit'
    )
    expect(result).not.toBeNull()
    expect(result?.repo).toBe(
      'mlx-community/gemma-4-26B-A4B-it-assistant-bf16'
    )
  })

  it('resolves gemma-4-31B QAT target to its MTP assistant', () => {
    const result = resolveMtpDraft('mlx-community/gemma-4-31B-it-qat-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('mlx-community/gemma-4-31B-it-assistant-bf16')
  })

  it('still resolves standard non-QAT target', () => {
    const result = resolveMtpDraft('mlx-community/gemma-4-E4B-it-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('mlx-community/gemma-4-E4B-it-assistant-bf16')
  })
})

describe('resolveEagle3Draft with QAT targets (ATO-235)', () => {
  it('resolves gemma-4-31B QAT target to its EAGLE-3 speculator', () => {
    const result = resolveEagle3Draft('mlx-community/gemma-4-31B-it-qat-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('RedHatAI/gemma-4-31B-it-speculator.eagle3')
  })

  it('resolves gemma-4-26B-A4B QAT target to its EAGLE-3 speculator', () => {
    const result = resolveEagle3Draft(
      'mlx-community/gemma-4-26B-A4B-it-qat-4bit'
    )
    expect(result).not.toBeNull()
    expect(result?.repo).toBe(
      'RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3'
    )
  })
})

describe('resolveDflashDraft with QAT targets (ATO-235)', () => {
  it('resolves gemma-4-31B QAT target to its DFlash draft', () => {
    const result = resolveDflashDraft('mlx-community/gemma-4-31B-it-qat-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('z-lab/gemma-4-31B-it-DFlash')
  })

  it('resolves gemma-4-26B-A4B QAT target to its DFlash draft', () => {
    const result = resolveDflashDraft(
      'mlx-community/gemma-4-26B-A4B-it-qat-4bit'
    )
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('z-lab/gemma-4-26B-A4B-it-DFlash')
  })

  it('still resolves standard Qwen DFlash target', () => {
    const result = resolveDflashDraft('mlx-community/Qwen3.5-4B-4bit')
    expect(result).not.toBeNull()
    expect(result?.repo).toBe('z-lab/Qwen3.5-4B-DFlash')
  })
})
