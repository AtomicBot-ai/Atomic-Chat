import { describe, expect, it } from 'vitest'

import {
  makeVideoCapabilities,
  makeVideoRequest,
  makeWanCapabilities,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { isValidFrameCount, validateVideoRequest } from '../validate'

const caps = makeVideoCapabilities()

const refused = (
  request: Parameters<typeof validateVideoRequest>[0],
  capabilities = caps
) => {
  const verdict = validateVideoRequest(request, capabilities)
  if (verdict.ok) throw new Error('expected a refusal')
  return verdict
}

describe('validateVideoRequest', () => {
  it('accepts a request inside every range, with or without the optional fields', () => {
    expect(validateVideoRequest(makeVideoRequest(), caps)).toEqual({ ok: true })
    expect(
      validateVideoRequest(
        makeVideoRequest({
          negativePrompt: 'blurry',
          guidance: 2,
          seed: 7,
          flowShift: 5,
          frames: 121,
          width: 1280,
          height: 704,
        }),
        makeWanCapabilities({ supportsGuidance: true })
      )
    ).toEqual({ ok: true })
    const { frames: _frames, fps: _fps, ...bare } = makeVideoRequest()
    expect(validateVideoRequest(bare, caps)).toEqual({ ok: true })
  })

  it('wants a prompt', () => {
    expect(refused(makeVideoRequest({ prompt: '  ' }))).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Enter a prompt to generate a video.',
    })
  })

  it('refuses image-to-video in every spelling', () => {
    for (const request of [
      makeVideoRequest({ workflow: 'image-to-video' }),
      makeVideoRequest({ initImage: { path: '/a.png' } }),
      makeVideoRequest({ endImage: { base64: 'QUJD' } }),
    ]) {
      expect(refused(request)).toMatchObject({
        code: 'UNSUPPORTED_WORKFLOW',
        message: 'Image-to-video is not available yet.',
      })
    }
    // An empty source is no source.
    expect(validateVideoRequest(makeVideoRequest({ initImage: { path: ' ' } }), caps)).toEqual({ ok: true })
    expect(refused(makeVideoRequest(), makeVideoCapabilities({ workflows: [] })).code).toBe(
      'UNSUPPORTED_WORKFLOW'
    )
  })

  it('checks the dimensions against the family: range, multiple, whole numbers', () => {
    expect(refused(makeVideoRequest({ width: 128 }))).toMatchObject({
      code: 'INVALID_DIMENSIONS',
      message: 'Width must be between 256 and 1216 pixels.',
    })
    expect(refused(makeVideoRequest({ height: 2000 })).message).toBe(
      'Height must be between 256 and 1216 pixels.'
    )
    expect(refused(makeVideoRequest({ width: 770 })).message).toBe(
      'Width must be a multiple of 32.'
    )
    expect(refused(makeVideoRequest({ height: 512.5 })).message).toBe(
      'Height must be a whole number.'
    )
    expect(
      validateVideoRequest(
        makeVideoRequest({ width: 770 }),
        makeVideoCapabilities({ dimMultiple: 1 })
      )
    ).toEqual({ ok: true })
  })

  it('keeps the steps, cfg, guidance, seed and flow shift sane', () => {
    expect(refused(makeVideoRequest({ steps: 0 })).message).toBe('Steps must be between 1 and 50.')
    expect(refused(makeVideoRequest({ steps: 51 })).code).toBe('INVALID_REQUEST')
    expect(refused(makeVideoRequest({ steps: 2.5 })).code).toBe('INVALID_REQUEST')
    expect(refused(makeVideoRequest({ cfgScale: -1 })).message).toBe('CFG scale must be zero or more.')
    expect(refused(makeVideoRequest({ cfgScale: Number.NaN })).code).toBe('INVALID_REQUEST')
    expect(refused(makeVideoRequest({ guidance: -0.5 })).message).toBe('Guidance must be zero or more.')
    expect(refused(makeVideoRequest({ seed: 1.5 })).message).toBe('Seed must be a whole number.')
    expect(refused(makeVideoRequest({ flowShift: 0 })).message).toBe(
      'Flow shift must be greater than zero.'
    )
  })

  it('holds the rate to the family and the frames to its lattice', () => {
    expect(refused(makeVideoRequest({ fps: 30 }))).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'This model generates at 24 fps.',
    })
    for (const frames of [48, 8, 265, 49.5]) {
      expect(refused(makeVideoRequest({ frames })), String(frames)).toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'Frames must be 8k+1 between 9 and 257.',
      })
    }
    expect(refused(makeVideoRequest({ frames: 50 }), makeWanCapabilities()).message).toBe(
      'Frames must be 4k+1 between 5 and 241.'
    )
    expect(validateVideoRequest(makeVideoRequest({ frames: 9 }), caps)).toEqual({ ok: true })
    expect(validateVideoRequest(makeVideoRequest({ frames: 257 }), caps)).toEqual({ ok: true })
  })

  it('refuses a negative prompt the model cannot use, but not an empty one', () => {
    expect(refused(makeVideoRequest({ negativePrompt: 'blurry' })).message).toBe(
      'This model does not take a negative prompt.'
    )
    expect(validateVideoRequest(makeVideoRequest({ negativePrompt: '  ' }), caps)).toEqual({
      ok: true,
    })
  })
})

describe('isValidFrameCount', () => {
  it('follows the lattice and the range, and takes any whole count when the step is unusable', () => {
    const lattice = caps.frames
    expect([9, 17, 121, 257].every((n) => isValidFrameCount(n, lattice))).toBe(true)
    expect([1, 8, 10, 258, 265, 9.5].some((n) => isValidFrameCount(n, lattice))).toBe(false)
    expect(isValidFrameCount(10, { ...lattice, step: 0 })).toBe(true)
  })
})
