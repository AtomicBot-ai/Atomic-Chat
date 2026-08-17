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
    expect(iconKeyLogoSrc('glm')).toBe('/svg/zai.svg')
    expect(iconKeyLogoSrc('minimax')).toBe('/svg/minimax.svg')
  })

  it('is case-insensitive', () => {
    expect(iconKeyLogoSrc('QWEN')).toBe('/svg/qwen-color.svg')
  })

  it('covers every brand the curated list ships with', () => {
    const keys = [
      'deepseek',
      'poolside',
      'prism',
      'gemma',
      'nvidia',
      'qwen',
      'minimax',
      'lfm',
      'glm',
      'mistral',
      'essentialai',
      'allenai',
      'ibm',
      'nous',
      'openai',
      'microsoft',
      'llama',
      'bytedance',
      'inclusionai',
      'nanbeige',
    ]
    for (const key of keys) {
      expect(iconKeyLogoSrc(key), `missing logo for "${key}"`).toBeTruthy()
    }
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

  it('recognizes the families added with the curated list', () => {
    expect(modelFamilyLogoSrc('unsloth/Nemotron-3-Nano-30B-A3B-GGUF')).toBe(
      '/images/model-provider/nvidia.svg'
    )
    expect(modelFamilyLogoSrc('unsloth/gpt-oss-20b-GGUF')).toBe(
      '/images/model-provider/openai.svg'
    )
    expect(modelFamilyLogoSrc('ibm-granite/granite-4.0-h-tiny-GGUF')).toBe(
      '/svg/ibm.svg'
    )
    expect(modelFamilyLogoSrc('unsloth/Olmo-3-32B-Think-GGUF')).toBe(
      '/svg/ai2-color.svg'
    )
    expect(modelFamilyLogoSrc('prism-ml/Bonsai-27B-gguf')).toBe(
      '/images/model-provider/prism-ml.webp'
    )
    expect(modelFamilyLogoSrc('microsoft/phi-4-gguf')).toBe(
      '/svg/microsoft-color.svg'
    )
    expect(modelFamilyLogoSrc('z-ai/GLM-4.7-Flash-GGUF')).toBe('/svg/zai.svg')
    expect(modelFamilyLogoSrc('unsloth/MiniMax-M2.7-GGUF')).toBe(
      '/svg/minimax.svg'
    )
  })

  it('keeps Bonsai on its own mark rather than the Qwen base it was built from', () => {
    expect(modelFamilyLogoSrc('prism-ml/Ternary-Bonsai-27B-gguf')).not.toBe(
      '/svg/qwen-color.svg'
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
    expect(isMonochromeFamilyLogo('/svg/ibm.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/nousresearch.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/zai.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/minimax.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/qwen-color.svg')).toBe(false)
    expect(isMonochromeFamilyLogo('/svg/ai2-color.svg')).toBe(false)
  })
})
