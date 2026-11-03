import { describe, expect, it } from 'vitest'

import { ggufCandidates, pickDefaultGeniexDevice, variantForChip } from '../hub'
import type { CatalogModel } from '@/services/models/types'

describe('ggufCandidates', () => {
  it('keeps the GGUF repositories of the catalog search and leaves the other formats out', () => {
    const models: CatalogModel[] = [
      { model_name: 'unsloth/Qwen3-4B-GGUF', description: '', downloads: 9, quants: [{ model_id: 'q', path: 'p', file_size: '1 GB' }] },
      { model_name: 'mlx-community/Qwen3-4B-4bit', description: '', downloads: 8, is_mlx: true },
      { model_name: 'Qwen/Qwen3-4B', description: '', downloads: 7, is_managed: true },
      { model_name: 'foundry-local/x', description: '', downloads: 6, is_foundry_local: true },
      { model_name: 'litert-lm/x', description: '', downloads: 5, is_litert_lm: true },
      { model_name: 'bartowski/Phi-4-mini-GGUF', description: '', downloads: 4, library_name: 'gguf' },
      { model_name: 'some/safetensors-model', description: '', downloads: 3 },
    ]
    expect(ggufCandidates(models)).toEqual(['unsloth/Qwen3-4B-GGUF', 'bartowski/Phi-4-mini-GGUF'])
  })
})

describe('pickDefaultGeniexDevice', () => {
  const verdicts = (map: Record<string, string>) => (device: string) => map[device]

  it('prefers the NPU, then the GPU, then the CPU among the devices the core says run here', () => {
    // spec geniex-models "Ноутбук с NPU".
    expect(pickDefaultGeniexDevice(['cpu', 'gpu', 'npu', 'hybrid'], verdicts({ npu: 'ok', gpu: 'ok', cpu: 'ok', hybrid: 'ok' }))).toBe('npu')
    expect(pickDefaultGeniexDevice(['npu', 'gpu', 'cpu'], verdicts({ npu: 'accelerator-unavailable', gpu: 'ok', cpu: 'ok' }))).toBe('gpu')
    expect(pickDefaultGeniexDevice(['npu', 'gpu', 'cpu'], verdicts({ npu: 'accelerator-unavailable', gpu: 'accelerator-unavailable', cpu: 'ok' }))).toBe('cpu')
  })

  it('never picks hybrid by itself, and nothing before any verdict is in or when none runs', () => {
    expect(pickDefaultGeniexDevice(['hybrid', 'cpu'], verdicts({ hybrid: 'ok', cpu: 'ok' }))).toBe('cpu')
    expect(pickDefaultGeniexDevice(['hybrid'], verdicts({ hybrid: 'ok' }))).toBeUndefined()
    expect(pickDefaultGeniexDevice(['npu', 'cpu'], () => undefined)).toBeUndefined()
    expect(pickDefaultGeniexDevice(['npu'], verdicts({ npu: 'engine-not-installed' }))).toBeUndefined()
  })
})

describe('variantForChip', () => {
  const variant = (chip: 'x-elite' | 'x2-elite') => ({
    id: `b-${chip}`,
    chip,
    bundle: { url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/b.zip', size: 1, sha256: 'a'.repeat(64) },
    precision: 'w4a16',
  })

  it('answers the bundle compiled for this computer’s chip, or nothing', () => {
    expect(variantForChip([variant('x-elite'), variant('x2-elite')], 'x2-elite')?.id).toBe('b-x2-elite')
    expect(variantForChip([variant('x2-elite')], 'x-elite')).toBeUndefined()
    expect(variantForChip([variant('x-elite')], null)).toBeUndefined()
  })
})
