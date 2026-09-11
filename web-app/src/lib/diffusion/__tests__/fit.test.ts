import { describe, expect, it } from 'vitest'

import type { HardwareProfile } from '@/lib/hardware-tier'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'

import {
  ACTIVATION_BYTES_PER_MEGAPIXEL,
  estimateDiffusionFit,
  estimateResidentBytes,
  fitForQuant,
  pickDefaultQuant,
} from '../fit'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const pc = (budgetMib: number): HardwareProfile => ({
  tier: 'vram_16',
  memoryKind: 'vram',
  budgetMib,
  systemRamMib: 65536,
  vramMib: budgetMib,
  hardCeiling: false,
})

const mac = (budgetMib: number): HardwareProfile => ({
  tier: 'unified_16',
  memoryKind: 'unified',
  budgetMib,
  systemRamMib: budgetMib,
  vramMib: 0,
  hardCeiling: true,
})

const input = (transformerGib: number, teOnCpu = true) => ({
  transformerBytes: transformerGib * GIB,
  vaeBytes: 0.3 * GIB,
  teBytes: 8 * GIB,
  teOnCpu,
  width: 1024,
  height: 1024,
})

describe('estimateResidentBytes', () => {
  it('adds the activations for one megapixel at 1024×1024', () => {
    expect(estimateResidentBytes(input(5))).toBeCloseTo(
      5.3 * GIB + ACTIVATION_BYTES_PER_MEGAPIXEL,
      -6
    )
  })

  it('scales activations with the output area', () => {
    const small = estimateResidentBytes({ ...input(5), width: 512, height: 512 })
    const large = estimateResidentBytes({ ...input(5), width: 2048, height: 2048 })
    expect(large - small).toBeCloseTo(3.75 * ACTIVATION_BYTES_PER_MEGAPIXEL, -6)
  })

  it('leaves the text encoder out when it runs on the CPU', () => {
    expect(
      estimateResidentBytes(input(5, false)) - estimateResidentBytes(input(5, true))
    ).toBe(8 * GIB)
  })
})

describe('estimateDiffusionFit', () => {
  it('reads the profile budget as MiB, not bytes', () => {
    // 16 GiB budget: 6.8 GiB resident is 42 % → ok. Read as bytes it would be "no".
    const result = estimateDiffusionFit(input(5), pc(16 * 1024))
    expect(result.budgetBytes).toBe(16 * 1024 * MIB)
    expect(result).toMatchObject({ fit: 'ok', policy: 'none' })
  })

  it('is fully resident up to 70 % of the budget', () => {
    // 9.25 + 0.25 + 1.5 = 11.0 GiB of 16 GiB = 68.75 % → ok;
    // 9.75 + 0.25 + 1.5 = 11.5 GiB of 16 GiB = 71.9 % → maybe.
    const below = estimateDiffusionFit(
      { ...input(9.25), vaeBytes: 0.25 * GIB },
      pc(16 * 1024)
    )
    const above = estimateDiffusionFit(
      { ...input(9.75), vaeBytes: 0.25 * GIB },
      pc(16 * 1024)
    )
    expect(below.fit).toBe('ok')
    expect(above.fit).toBe('maybe')
  })

  it('offloads in groups between 70 % and 90 %', () => {
    // 13.3 GiB of 16 GiB = 83 %
    expect(estimateDiffusionFit(input(11.5), pc(16 * 1024))).toMatchObject({
      fit: 'maybe',
      policy: 'group',
    })
  })

  it('offloads the whole model past 90 %', () => {
    // 5.3 + 8 (TE on GPU) + 1.5 = 14.8 GiB of 16 GiB = 92.5 %
    expect(estimateDiffusionFit(input(5, false), pc(16 * 1024))).toMatchObject({
      fit: 'no',
      policy: 'model',
    })
  })

  it('applies the measured Metal ceiling on macOS', () => {
    // 10 GiB resident (8.2 + 0.3 + 1.5): 62.5 % of a 16 GiB PC budget, but
    // 73.5 % of the 13.6 GiB a Mac will actually hand out.
    const onPc = estimateDiffusionFit(input(8.2), pc(16 * 1024))
    const onMac = estimateDiffusionFit(input(8.2), mac(16 * 1024))
    expect(onPc.fit).toBe('ok')
    expect(onMac.fit).toBe('maybe')
    expect(onMac.budgetBytes).toBeCloseTo(16 * 1024 * MIB * 0.85, -3)
  })

  it('answers maybe/group when the hardware is not known yet', () => {
    expect(estimateDiffusionFit(input(5), null)).toMatchObject({
      fit: 'maybe',
      policy: 'group',
      budgetBytes: null,
    })
  })

  it('quotes both sizes in the reason', () => {
    expect(estimateDiffusionFit(input(5), pc(16 * 1024)).reason).toBe(
      'Needs about 6.8 GB of 16.0 GB available.'
    )
  })
})

const family: DiffusionCatalogFamily = {
  id: 'z-image',
  name: 'Z-Image Turbo',
  modality: 'image',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/Z-Image-Turbo-GGUF',
    quants: [
      { id: 'q3_k_m', label: 'Q3_K_M', filename: 'z-Q3_K_M.gguf', bytes: 4 * GIB },
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'z-Q4_K_M.gguf',
        bytes: 5 * GIB,
        recommended: true,
      },
      { id: 'q6_k', label: 'Q6_K', filename: 'z-Q6_K.gguf', bytes: 6 * GIB },
      { id: 'q8_0', label: 'Q8_0', filename: 'z-Q8_0.gguf', bytes: 7 * GIB },
    ],
  },
  vae: { repo: 'unsloth/Z-Image-Turbo-ComfyUI', filename: 'ae.safetensors', bytes: 0.3 * GIB },
  text_encoders: [
    {
      repo: 'unsloth/Z-Image-Turbo-ComfyUI',
      filename: 'qwen_3_4b.safetensors',
      bytes: 8 * GIB,
      field: 'llm',
    },
  ],
  defaults: { steps: 8, cfg_scale: 1, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: { negative_prompt: false, guidance: false, workflows: ['create'] },
}

describe('fitForQuant', () => {
  it('uses the family defaults and side files', () => {
    // 7 + 0.3 + 1.5 = 8.8 GiB with the TE on the CPU.
    const result = fitForQuant(family, family.transformer.quants[3], pc(12 * 1024), {
      teOnCpu: true,
    })
    expect(result.residentBytes).toBeCloseTo(8.8 * GIB, -6)
    expect(result.fit).toBe('maybe')
  })
})

describe('pickDefaultQuant', () => {
  const quantIds = (profile: HardwareProfile | null, installed: string[] = []) =>
    pickDefaultQuant(family, profile, installed, { teOnCpu: true }).id

  it('prefers the largest installed quant that still fits', () => {
    // 12 GiB budget: Q8 = 8.8 GiB (73 %, maybe), Q6 = 7.8 GiB (65 %, ok).
    expect(quantIds(pc(12 * 1024), ['z-image:q3_k_m', 'z-image:q8_0'])).toBe('q8_0')
  })

  it('accepts bare quant ids as installed', () => {
    expect(quantIds(pc(12 * 1024), ['q6_k'])).toBe('q6_k')
  })

  it('skips an installed quant that does not fit', () => {
    // 8 GiB budget: Q8 = 8.8 GiB (110 %, no); recommended Q4 = 6.8 GiB (85 %, maybe).
    expect(quantIds(pc(8 * 1024), ['z-image:q8_0'])).toBe('q4_k_m')
  })

  it('falls back to the recommended quant', () => {
    expect(quantIds(pc(12 * 1024))).toBe('q4_k_m')
  })

  it('falls to the largest maybe when the recommendation is a no and nothing is ok', () => {
    // 7.5 GiB budget: Q4 = 6.8 GiB (91 %, no); Q3 = 5.8 GiB (77 %, maybe).
    // Nothing is "ok", so the largest "maybe" wins.
    expect(quantIds(pc(7.5 * 1024))).toBe('q3_k_m')
  })

  it('takes the largest ok quant when nothing is recommended', () => {
    const noRecommendation: DiffusionCatalogFamily = {
      ...family,
      transformer: {
        ...family.transformer,
        quants: family.transformer.quants.map(({ recommended: _r, ...q }) => q),
      },
    }
    // 10 GiB budget: Q3 = 5.8 (58 %, ok), Q4 = 6.8 (68 %, ok), Q6 = 7.8 (78 %, maybe).
    expect(
      pickDefaultQuant(noRecommendation, pc(10 * 1024), [], { teOnCpu: true }).id
    ).toBe('q4_k_m')
  })

  it('offers the smallest quant when nothing fits', () => {
    expect(quantIds(pc(4 * 1024))).toBe('q3_k_m')
  })

  it('leans on the recommendation while hardware is unknown', () => {
    expect(quantIds(null)).toBe('q4_k_m')
  })
})
