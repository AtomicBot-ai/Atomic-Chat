import { describe, expect, it } from 'vitest'

import {
  durationChoices,
  effectiveImageOptions,
  effectiveVideoOptions,
  nominalVideoSize,
  parseSize,
  pickChoice,
  remoteChoiceLabel,
  remoteImageCapabilities,
} from '@/lib/media-capabilities'
import type {
  ImageModelDescriptor,
  VideoModelDescriptor,
} from '@/services/media/types'

const image = (params: ImageModelDescriptor['params']): ImageModelDescriptor => ({
  id: 'm',
  name: 'M',
  kind: 'image',
  api: 'openai-images',
  workflows: ['create', 'edit'],
  params,
  source: 'catalog',
})

const video = (params: VideoModelDescriptor['params']): VideoModelDescriptor => ({
  id: 'v',
  name: 'V',
  kind: 'video',
  api: 'openrouter-videos',
  workflows: ['create'],
  params,
  source: 'catalog',
})

describe('parseSize / pickChoice', () => {
  it('reads WxH and nothing else', () => {
    expect(parseSize('1536x1024')).toEqual({ width: 1536, height: 1024 })
    expect(parseSize('auto')).toBeUndefined()
    expect(parseSize(undefined)).toBeUndefined()
  })

  it('keeps an offered value and falls back to the default, then the first', () => {
    expect(pickChoice({ values: ['a', 'b'], default: 'b' }, 'a')).toBe('a')
    expect(pickChoice({ values: ['a', 'b'], default: 'b' }, 'z')).toBe('b')
    expect(pickChoice({ values: ['a', 'b'] }, undefined)).toBe('a')
    expect(pickChoice(undefined, 'a')).toBeUndefined()
  })
})

describe('remoteImageCapabilities', () => {
  it('takes a size range and the sampling a self-hosted server offers', () => {
    const caps = remoteImageCapabilities(
      image({
        size: { kind: 'range', min: 256, max: 2048, multiple: 8, default_width: 768, default_height: 512 },
        steps: { min: 1, max: 150, default: 25 },
        cfg: { min: 1, max: 30, default: 7 },
        negative_prompt: true,
        n: { max: 4 },
      })
    )
    expect(caps).toMatchObject({
      workflows: ['create', 'edit'],
      minDim: 256,
      maxDim: 2048,
      dimMultiple: 8,
      supportsNegativePrompt: true,
      supportsGuidance: false,
      maxBatch: 4,
      defaults: { steps: 25, cfgScale: 7, width: 768, height: 512 },
      ranges: { steps: [1, 150], dims: [256, 2048], dimMultiple: 8 },
    })
  })

  it('has no steps or CFG for a cloud model, and takes its listed default size', () => {
    const caps = remoteImageCapabilities(
      image({ size: { kind: 'enum', values: ['1024x1024', '1536x1024'], default: '1536x1024' } })
    )
    expect(caps.defaults).toMatchObject({ steps: 0, cfgScale: 0, width: 1536, height: 1024 })
    expect(caps.ranges.steps).toEqual([0, 0])
    expect(caps.maxBatch).toBe(1)
  })

  it('reports guidance with its default', () => {
    const caps = remoteImageCapabilities(image({ guidance: { min: 0, max: 10, default: 3.5 } }))
    expect(caps.supportsGuidance).toBe(true)
    expect(caps.defaults.guidance).toBe(3.5)
    expect(caps.defaults.width).toBe(1024)
  })
})

describe('effectiveImageOptions', () => {
  it('checks every setting against what the model offers', () => {
    const model = image({
      size: { kind: 'enum', values: ['1024x1024', '1536x1024'], default: '1024x1024' },
      quality: { values: ['low', 'high'], default: 'high' },
      output_format: { values: ['png', 'webp'] },
    })
    expect(
      effectiveImageOptions(model, { size: '9x9', quality: 'low', background: 'transparent' })
    ).toEqual({ size: '1024x1024', quality: 'low', outputFormat: 'png' })
  })

  it('sends no size for a range model: the form’s width and height carry it', () => {
    const model = image({ size: { kind: 'range', min: 64, max: 2048, multiple: 8 } })
    expect(effectiveImageOptions(model, { size: '1024x1024' })).toEqual({})
  })
})

describe('durations and video options', () => {
  it('lists the offered lengths, sorted, or every second of a range', () => {
    expect(durationChoices(video({ durations: { values: [8, 4, 6] } }))).toEqual([4, 6, 8])
    expect(durationChoices(video({ durations: { min: 2.5, max: 5 } }))).toEqual([3, 4, 5])
    expect(durationChoices(video({}))).toEqual([])
  })

  it('checks the length and settings against the model', () => {
    const model = video({
      durations: { values: [4, 8], default: 8 },
      resolutions: { values: ['720p', '1080p'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16'] },
      audio: true,
    })
    expect(
      effectiveVideoOptions(model, { durationSecs: 5, resolution: '1080p', generateAudio: false })
    ).toEqual({ durationSecs: 8, resolution: '1080p', aspectRatio: '16:9', generateAudio: false })
    expect(effectiveVideoOptions(model, { durationSecs: 4 }).durationSecs).toBe(4)
  })

  it('drops sound for a model without it', () => {
    expect(effectiveVideoOptions(video({}), { generateAudio: true })).toEqual({})
  })

  it('sizes the pending tile from the listed size, the tier and the ratio', () => {
    expect(nominalVideoSize({ size: '1280x720' })).toEqual({ width: 1280, height: 720 })
    expect(nominalVideoSize({ resolution: '1080p', aspectRatio: '9:16' })).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(nominalVideoSize({ resolution: '4K' })).toEqual({ width: 3840, height: 2160 })
    expect(nominalVideoSize({})).toEqual({ width: 1280, height: 720 })
  })
})

describe('remoteChoiceLabel', () => {
  const t = (key: string) => `t(${key})`

  it('labels sizes, formats and words', () => {
    expect(remoteChoiceLabel('1536x1024', t)).toBe('1536 × 1024')
    expect(remoteChoiceLabel('webp', t)).toBe('WEBP')
    expect(remoteChoiceLabel('high', t)).toBe('High')
    expect(remoteChoiceLabel('auto', t)).toBe('t(images:remote.auto)')
  })
})
