import { describe, expect, it } from 'vitest'
import {
  estimateFit,
  parseFileSizeToBytes,
  pickSmallestQuant,
} from '../model-card'

describe('model card hardware fit', () => {
  it('uses a fitting quant instead of blocking on a larger variant', () => {
    const quant = pickSmallestQuant([
      {
        model_id: 'model-Q8_0',
        path: 'model-Q8_0.gguf',
        file_size: '40 GB',
      },
      {
        model_id: 'model-IQ2_XXS',
        path: 'model-IQ2_XXS.gguf',
        file_size: '8 GB',
      },
    ])

    expect(quant?.model_id).toBe('model-IQ2_XXS')
    expect(
      estimateFit(
        parseFileSizeToBytes(quant?.file_size),
        parseFileSizeToBytes('32 GB')
      )
    ).toBe('ok')
  })
})
