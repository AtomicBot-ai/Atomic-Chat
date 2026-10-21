import { describe, expect, it } from 'vitest'
import {
  FLUX3_IMAGE_ENGINE_TAG,
  MODERN_IMAGE_ENGINE_TAG,
  requiredEngineTag,
  supportsDiffusionFamily,
} from '../compatibility'

describe('requiredEngineTag', () => {
  it('names the first build of each gated family and nothing for the rest', () => {
    for (const family of [
      'qwen-image-2.1',
      'qwen-image-2.1-turbo',
      'krea-2-turbo',
    ])
      expect(requiredEngineTag(family), family).toBe(MODERN_IMAGE_ENGINE_TAG)
    expect(requiredEngineTag('flux.3-klein')).toBe(FLUX3_IMAGE_ENGINE_TAG)
    for (const family of [
      'z-image',
      'flux.1',
      'flux.2-klein',
      'ltx-2',
      'constructor',
    ])
      expect(requiredEngineTag(family), family).toBeNull()
  })
})

describe('supportsDiffusionFamily', () => {
  it('holds FLUX.3 Klein to build 968 and fails closed on odd tags', () => {
    for (const tag of [
      'master-883-137f740-a36f1b1a',
      'master-967-e47426c',
      'master-968',
      'unknown',
    ])
      expect(supportsDiffusionFamily('flux.3-klein', tag), tag).toBe(false)
    for (const tag of [
      'master-968-8cd731e',
      'master-975-95b3090',
      'master-982-0518b34-a1234567',
    ])
      expect(supportsDiffusionFamily('flux.3-klein', tag), tag).toBe(true)
  })

  it('keeps the 883 floor for Qwen Image 2.1 and Krea 2 Turbo', () => {
    expect(supportsDiffusionFamily('krea-2-turbo', 'master-882-abcdef0')).toBe(
      false
    )
    expect(
      supportsDiffusionFamily('qwen-image-2.1', 'master-883-137f740-a36f1b1a')
    ).toBe(true)
  })

  it('serves every other family on any engine', () => {
    expect(supportsDiffusionFamily('flux.2-klein', 'unknown')).toBe(true)
  })
})
