import { describe, expect, it } from 'vitest'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import {
  deriveCapabilities,
  estimateFit,
  parseFileSizeToBytes,
  pickDownloadQuant,
  pickMedianQuant,
  quantLabel,
} from '../model-card'

const GB = 1024 ** 3

const repo = (
  quants: ModelQuant[],
  mmproj?: Array<{ model_id: string; file_size: string }>
): CatalogModel =>
  ({
    model_name: 'prism-ml/Bonsai-27B-gguf',
    developer: 'prism-ml',
    num_quants: quants.length,
    quants,
    mmproj_models: mmproj ?? [],
  }) as unknown as CatalogModel

describe('pickMedianQuant', () => {
  it('quotes the middle variant instead of the smallest rounding', () => {
    const quant = pickMedianQuant([
      { model_id: 'model-Q8_0', path: 'q8.gguf', file_size: '40 GB' },
      { model_id: 'model-IQ2_XXS', path: 'iq2.gguf', file_size: '8 GB' },
      { model_id: 'model-Q4_K_M', path: 'q4.gguf', file_size: '20 GB' },
    ])

    expect(quant?.model_id).toBe('model-Q4_K_M')
  })

  it('ignores catalog order when picking the median', () => {
    const quant = pickMedianQuant([
      { model_id: 'a', path: 'a.gguf', file_size: '2 GB' },
      { model_id: 'b', path: 'b.gguf', file_size: '30 GB' },
      { model_id: 'c', path: 'c.gguf', file_size: '6 GB' },
      { model_id: 'd', path: 'd.gguf', file_size: '4 GB' },
      { model_id: 'e', path: 'e.gguf', file_size: '9 GB' },
    ])

    expect(quant?.model_id).toBe('c')
  })

  it('takes the lower of the two middle variants on an even count', () => {
    const quant = pickMedianQuant([
      { model_id: 'a', path: 'a.gguf', file_size: '2 GB' },
      { model_id: 'b', path: 'b.gguf', file_size: '4 GB' },
      { model_id: 'c', path: 'c.gguf', file_size: '8 GB' },
      { model_id: 'd', path: 'd.gguf', file_size: '16 GB' },
    ])

    expect(quant?.model_id).toBe('b')
  })

  it('skips variants with no declared size rather than counting them as zero', () => {
    const quant = pickMedianQuant([
      { model_id: 'unknown-1', path: 'u1.gguf', file_size: '' },
      { model_id: 'unknown-2', path: 'u2.gguf' },
      { model_id: 'small', path: 's.gguf', file_size: '4 GB' },
      { model_id: 'mid', path: 'm.gguf', file_size: '8 GB' },
      { model_id: 'large', path: 'l.gguf', file_size: '16 GB' },
    ])

    expect(quant?.model_id).toBe('mid')
  })

  it('keeps catalog order when no variant declares a size', () => {
    const quant = pickMedianQuant([
      { model_id: 'first', path: 'first.gguf' },
      { model_id: 'second', path: 'second.gguf' },
    ])

    expect(quant?.model_id).toBe('first')
  })

  it('returns nothing for a repo with no quants', () => {
    expect(pickMedianQuant([])).toBeUndefined()
    expect(pickMedianQuant(undefined)).toBeUndefined()
  })
})

describe('quantLabel', () => {
  it.each([
    ['unsloth/UD-IQ4_XS/Kimi-K3-UD-IQ4_XS', 'IQ4_XS'],
    ['unsloth/UD-Q2_K_XL/Kimi-K3-UD-Q2_K_XL', 'Q2_K_XL'],
    // Ternary quants: without them the badge fell back to the trailing "0".
    ['unsloth/UD-TQ1_0/Kimi-K3-UD-TQ1_0', 'TQ1_0'],
    ['model-BF16', 'BF16'],
    ['mlx-community/Qwen3.5-9B-4bit', '4BIT'],
  ])('reads %s as %s', (modelId, label) => {
    expect(quantLabel(modelId)).toBe(label)
  })
})

describe('pickDownloadQuant', () => {
  const bonsai = () =>
    repo([
      { model_id: 'Bonsai-27B-F16', path: 'f16.gguf', file_size: '51.0 GB' },
      { model_id: 'Bonsai-27B-Q1_0', path: 'q1.gguf', file_size: '4.4 GB' },
      { model_id: 'Bonsai-27B-Q4_1', path: 'q4-1.gguf', file_size: '2.6 GB' },
      { model_id: 'Bonsai-27B-BF16', path: 'bf16.gguf', file_size: '7.7 GB' },
    ])

  it('keeps the house default when the repo ships it', () => {
    const model = repo([
      { model_id: 'model-Q2_K', path: 'q2.gguf', file_size: '1.2 GB' },
      { model_id: 'model-Q4_K_M', path: 'q4.gguf', file_size: '2.5 GB' },
      { model_id: 'model-Q8_0', path: 'q8.gguf', file_size: '4.5 GB' },
    ])

    expect(pickDownloadQuant(model, 16 * GB)?.model_id).toBe('model-Q4_K_M')
  })

  it('opens on the median rather than the catalog dump the row never quoted', () => {
    const quant = pickDownloadQuant(bonsai(), 24 * GB)

    expect(quant?.model_id).toBe('Bonsai-27B-Q1_0')
    expect(estimateFit(parseFileSizeToBytes(quant?.file_size), 24 * GB)).toBe(
      'ok'
    )
  })

  it('steps down to the largest variant the device can hold', () => {
    const model = repo([
      { model_id: 'model-Q2_K', path: 'q2.gguf', file_size: '3 GB' },
      { model_id: 'model-Q3_K_M', path: 'q3.gguf', file_size: '5 GB' },
      { model_id: 'model-Q4_K_M', path: 'q4.gguf', file_size: '20 GB' },
    ])

    expect(pickDownloadQuant(model, 8 * GB)?.model_id).toBe('model-Q3_K_M')
  })

  it('offers the smallest variant when the device can hold none of them', () => {
    expect(pickDownloadQuant(bonsai(), 2 * GB)?.model_id).toBe('Bonsai-27B-Q4_1')
  })

  it('counts the vision projector against the budget', () => {
    const model = repo(
      [
        { model_id: 'model-Q2_K', path: 'q2.gguf', file_size: '3 GB' },
        { model_id: 'model-Q4_K_M', path: 'q4.gguf', file_size: '7 GB' },
      ],
      [{ model_id: 'mmproj-f16', file_size: '2 GB' }]
    )

    // Q4_K_M alone fits an 8 GB device; with the projector it no longer does.
    expect(pickDownloadQuant(model, 8 * GB)?.model_id).toBe('model-Q2_K')
  })

  it('leaves the pick to the repo while the budget is unknown', () => {
    expect(pickDownloadQuant(bonsai(), 0)?.model_id).toBe('Bonsai-27B-Q1_0')
  })

  it('returns nothing for a repo with no quants', () => {
    expect(pickDownloadQuant(repo([]), 16 * GB)).toBeUndefined()
  })
})

describe('model card hardware fit', () => {
  it('judges the median variant, not the quant nobody runs', () => {
    const quant = pickMedianQuant([
      { model_id: 'model-IQ2_XXS', path: 'iq2.gguf', file_size: '8 GB' },
      { model_id: 'model-Q4_K_M', path: 'q4.gguf', file_size: '20 GB' },
      { model_id: 'model-Q8_0', path: 'q8.gguf', file_size: '40 GB' },
    ])

    const budget = parseFileSizeToBytes('26 GB')

    // The 8 GB rounding would have promised a comfortable fit on this device.
    expect(estimateFit(parseFileSizeToBytes('8 GB'), budget)).toBe('ok')
    expect(estimateFit(parseFileSizeToBytes(quant?.file_size), budget)).toBe(
      'maybe'
    )
  })
})

describe('deriveCapabilities', () => {
  const labels = (model: CatalogModel, curated?: string[]) =>
    deriveCapabilities(
      model,
      curated as Parameters<typeof deriveCapabilities>[1]
    ).map((cap) => cap.label)

  const catalog = (overrides: Partial<CatalogModel> = {}): CatalogModel =>
    ({
      model_name: 'AtomicChat/Some-Model-GGUF',
      developer: 'AtomicChat',
      quants: [],
      mmproj_models: [],
      ...overrides,
    }) as unknown as CatalogModel

  it('reads capabilities off catalog signals when nothing is curated', () => {
    expect(
      labels(
        catalog({
          model_name: 'unsloth/Some-VL-Thinking-GGUF',
          num_mmproj: 1,
          tools: true,
        })
      )
    ).toEqual(['Vision', 'Tool Use', 'Reasoning'])
  })

  it('lets a curated pick add what the catalog never advertised', () => {
    // Qwen3.5 ships a vision encoder, but nothing in the repo id or the
    // catalog entry says so.
    const model = catalog({ model_name: 'AtomicChat/Qwen3.5-9B-GGUF' })
    expect(labels(model)).toEqual([])
    expect(labels(model, ['general', 'vision', 'reasoning', 'tools'])).toEqual([
      'Vision',
      'Tool Use',
      'Reasoning',
    ])
  })

  it('lets a curated pick drop what the heuristic guessed wrong', () => {
    // "recMathReasoning" wording made Phi 4 look like a thinking model.
    const model = catalog({
      model_name: 'microsoft/phi-4-gguf',
      description: 'Strong on advanced reasoning for its size.',
    })
    expect(labels(model)).toEqual(['Reasoning'])
    expect(labels(model, ['general'])).toEqual([])
  })

  it('badges curated audio, which no catalog field exposes', () => {
    expect(
      labels(catalog({ model_name: 'AtomicChat/gemma-4-E2B-it-GGUF' }), [
        'general',
        'compact',
        'vision',
        'audio',
        'reasoning',
        'tools',
      ])
    ).toEqual(['Vision', 'Tool Use', 'Reasoning', 'Audio'])
  })

  it('falls back to the heuristic for a pick published without categories', () => {
    const model = catalog({
      model_name: 'unsloth/Olmo-3-32B-Think-GGUF',
      description: 'Fully open reasoning model from Ai2.',
      tools: true,
    })
    expect(labels(model, undefined)).toEqual(['Tool Use', 'Reasoning'])
  })
})
