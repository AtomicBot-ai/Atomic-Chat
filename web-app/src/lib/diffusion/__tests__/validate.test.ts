import { describe, expect, it } from 'vitest'

import type {
  ImageCapabilities,
  ImageGenerateRequest,
} from '@/services/diffusion/types'

import { validateImageRequest } from '../validate'

const caps: ImageCapabilities = {
  workflows: ['create'],
  minDim: 256,
  maxDim: 2048,
  dimMultiple: 16,
  supportsNegativePrompt: false,
  supportsGuidance: false,
  cancelGenerating: false,
  maxBatch: 4,
  defaults: { steps: 8, cfgScale: 1, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
}

const request = (
  overrides: Partial<ImageGenerateRequest> = {}
): ImageGenerateRequest => ({
  prompt: 'a cat wearing a tiny hat',
  width: 1024,
  height: 1024,
  steps: 8,
  cfgScale: 1,
  batchSize: 1,
  ...overrides,
})

describe('validateImageRequest', () => {
  it('accepts a request inside every range', () => {
    expect(validateImageRequest(request(), caps)).toEqual({ ok: true })
  })

  it('accepts a negative seed as "let the engine draw one"', () => {
    expect(validateImageRequest(request({ seed: -1 }), caps)).toEqual({
      ok: true,
    })
  })

  it('wants a prompt', () => {
    const result = validateImageRequest(request({ prompt: '   ' }), caps)
    expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })

  it('rejects dimensions outside the range, naming the axis', () => {
    const result = validateImageRequest(request({ height: 4096 }), caps)
    expect(result).toMatchObject({ ok: false, code: 'INVALID_DIMENSIONS' })
    expect((result as { message: string }).message).toMatch(/^Height/)
  })

  it('rejects dimensions off the multiple', () => {
    expect(validateImageRequest(request({ width: 1000 }), caps)).toMatchObject({
      ok: false,
      code: 'INVALID_DIMENSIONS',
      message: 'Width must be a multiple of 16.',
    })
  })

  it('rejects fractional dimensions', () => {
    expect(validateImageRequest(request({ width: 512.5 }), caps)).toMatchObject({
      ok: false,
      code: 'INVALID_DIMENSIONS',
    })
  })

  it('keeps steps inside the family range', () => {
    expect(validateImageRequest(request({ steps: 51 }), caps)).toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'Steps must be between 1 and 50.',
    })
    expect(validateImageRequest(request({ steps: 0 }), caps)).toMatchObject({
      ok: false,
    })
  })

  it('caps the batch at what the engine allows', () => {
    expect(validateImageRequest(request({ batchSize: 5 }), caps)).toMatchObject({
      ok: false,
      message: 'Batch size must be between 1 and 4.',
    })
    expect(
      validateImageRequest(request({ batchSize: 2 }), { ...caps, maxBatch: 1 })
    ).toMatchObject({ ok: false, message: 'This model generates one image per job.' })
  })

  it('refuses a negative prompt the model cannot use, but not an empty one', () => {
    expect(
      validateImageRequest(request({ negativePrompt: 'blurry' }), caps)
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(
      validateImageRequest(request({ negativePrompt: '' }), caps)
    ).toEqual({ ok: true })
    expect(
      validateImageRequest(request({ negativePrompt: 'blurry' }), {
        ...caps,
        supportsNegativePrompt: true,
      })
    ).toEqual({ ok: true })
  })

  it('names an unsupported workflow', () => {
    expect(
      validateImageRequest(request({ workflow: 'transform' }), caps)
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_WORKFLOW' })
  })

  it('needs a source image and a sane strength to transform', () => {
    const editing: ImageCapabilities = { ...caps, workflows: ['create', 'transform'] }
    expect(
      validateImageRequest(request({ workflow: 'transform' }), editing)
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(
      validateImageRequest(
        request({ workflow: 'transform', initImage: { path: '/in.png' }, strength: 1.5 }),
        editing
      )
    ).toMatchObject({ ok: false, message: 'Strength must be between 0 and 1.' })
    expect(
      validateImageRequest(
        request({ workflow: 'transform', initImage: { path: '/in.png' }, strength: 0.6 }),
        editing
      )
    ).toEqual({ ok: true })
  })

  it('checks the inputs of every image workflow', () => {
    const all: ImageCapabilities = {
      ...caps,
      workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale', 'reference', 'edit'],
    }
    const source = { path: '/in.png' }
    const mask = { base64: 'data:image/png;base64,QUJD' }

    for (const workflow of ['inpaint', 'extend'] as const) {
      expect(
        validateImageRequest(request({ workflow, initImage: source }), all)
      ).toMatchObject({ ok: false, message: 'Paint the area to change first.' })
      expect(
        validateImageRequest(
          request({ workflow, initImage: source, maskImage: mask }),
          all
        )
      ).toEqual({ ok: true })
    }

    expect(
      validateImageRequest(request({ workflow: 'upscale', initImage: mask }), all)
    ).toEqual({ ok: true })
    expect(
      validateImageRequest(request({ workflow: 'edit' }), all)
    ).toMatchObject({ ok: false, message: 'Choose a source image first.' })
    expect(
      validateImageRequest(
        request({
          workflow: 'reference',
          initImage: source,
          referenceImages: [source, source, source, source],
        }),
        all
      )
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(
      validateImageRequest(
        request({ workflow: 'reference', initImage: source, referenceImages: [{ path: '' }] }),
        all
      )
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(
      validateImageRequest(
        request({ workflow: 'reference', initImage: source, referenceImages: [source] }),
        all
      )
    ).toEqual({ ok: true })
  })

  it('rejects malformed numbers', () => {
    expect(validateImageRequest(request({ cfgScale: -1 }), caps)).toMatchObject({
      ok: false,
    })
    expect(validateImageRequest(request({ guidance: NaN }), caps)).toMatchObject({
      ok: false,
    })
    expect(validateImageRequest(request({ seed: 1.5 }), caps)).toMatchObject({
      ok: false,
      message: 'Seed must be a whole number.',
    })
    expect(validateImageRequest(request({ flowShift: 0 }), caps)).toMatchObject({
      ok: false,
    })
  })
})
