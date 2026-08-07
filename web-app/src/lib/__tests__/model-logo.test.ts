import { describe, expect, it } from 'vitest'
import {
  HUGGINGFACE_LOGO_SRC,
  iconKeyLogoSrc,
  isMonochromeFamilyLogo,
  modelFamilyLogoSrc,
} from '../model-logo'

describe('iconKeyLogoSrc', () => {
  it('resolves a manifest icon key to a bundled asset', () => {
    expect(iconKeyLogoSrc('qwen')).toBe('/svg/qwen-color.svg')
    expect(iconKeyLogoSrc('gemma')).toBe('/svg/google-color.svg')
    expect(iconKeyLogoSrc('google')).toBe('/svg/google-color.svg')
    expect(iconKeyLogoSrc('llama')).toBe('/svg/meta-color.svg')
  })

  it('is case-insensitive', () => {
    expect(iconKeyLogoSrc('QWEN')).toBe('/svg/qwen-color.svg')
  })

  it('returns null for an unknown or missing key', () => {
    expect(iconKeyLogoSrc('not-a-brand')).toBeNull()
    expect(iconKeyLogoSrc('')).toBeNull()
    expect(iconKeyLogoSrc(undefined)).toBeNull()
  })

  it('exposes the Hugging Face mark used for long-tail results', () => {
    expect(HUGGINGFACE_LOGO_SRC).toBe('/images/model-provider/huggingface.svg')
    expect(iconKeyLogoSrc('huggingface')).toBe(HUGGINGFACE_LOGO_SRC)
  })
})

describe('modelFamilyLogoSrc', () => {
  it('matches a family regardless of the quantizing org', () => {
    expect(modelFamilyLogoSrc('someone/gemma-4-12b-it-GGUF')).toBe(
      '/svg/google-color.svg'
    )
    expect(modelFamilyLogoSrc('AtomicChat/Qwen3.5-4B-GGUF')).toBe(
      '/svg/qwen-color.svg'
    )
  })

  it('prefers the more specific family for distills', () => {
    expect(modelFamilyLogoSrc('x/DeepSeek-R1-Distill-Qwen-7B')).toBe(
      '/svg/deepseek-color.svg'
    )
  })

  it('returns null for an unknown family or missing name', () => {
    expect(modelFamilyLogoSrc('someone/entirely-unknown')).toBeNull()
    expect(modelFamilyLogoSrc(undefined)).toBeNull()
  })
})

describe('isMonochromeFamilyLogo', () => {
  it('flags marks that must be tinted through a CSS mask', () => {
    expect(isMonochromeFamilyLogo('/svg/liquid.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/qwen-color.svg')).toBe(false)
  })
})
