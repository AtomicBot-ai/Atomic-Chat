import { describe, expect, it } from 'vitest'
import { BASELINE_DIFFUSION_CATALOG } from '@/services/diffusion-catalog-baseline'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import {
  decisionIconKey,
  DIFFUSION_FAMILY_ICON_KEYS,
  embeddingIconKey,
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
      'ling',
      'nanbeige',
      'ornith',
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

  it('draws EmbeddingGemma with the Gemma mark, other Gemma models with the Google one', () => {
    expect(modelFamilyLogoSrc('ggml-org/embeddinggemma-300M-GGUF')).toBe(
      '/svg/gemma-color.svg'
    )
    expect(modelFamilyLogoSrc('EmbeddingGemma 2')).toBe('/svg/gemma-color.svg')
    expect(modelFamilyLogoSrc('unsloth/gemma-4-12b-it-GGUF')).toBe(
      '/svg/google-color.svg'
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
      '/svg/openai-mark.svg'
    )
    expect(isMonochromeFamilyLogo('/svg/openai-mark.svg')).toBe(true)
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
    expect(modelFamilyLogoSrc('AtomicChat/Ornith-1.5-35B-A3B-GGUF')).toBe(
      '/images/model-provider/ornith.webp'
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

describe('image and video families', () => {
  it('gives every family in the offline catalog a bundled mark, by id and by name', () => {
    for (const family of BASELINE_DIFFUSION_CATALOG.families) {
      const byId = iconKeyLogoSrc(DIFFUSION_FAMILY_ICON_KEYS[family.id])
      expect(byId, `no icon key for "${family.id}"`).toBeTruthy()
      // A card drawn from the family name must not show another mark than one
      // drawn from its id.
      expect(
        modelFamilyLogoSrc(family.name),
        `name rule for "${family.name}"`
      ).toBe(byId)
    }
  })

  it('draws each family under its publisher', () => {
    expect(modelFamilyLogoSrc('FLUX.2 Klein 4B')).toBe('/svg/bfl.svg')
    expect(modelFamilyLogoSrc('black-forest-labs/FLUX.1-schnell')).toBe(
      '/svg/bfl.svg'
    )
    expect(modelFamilyLogoSrc('city96/flux1-dev-gguf')).toBe('/svg/bfl.svg')
    expect(modelFamilyLogoSrc('Z-Image Turbo')).toBe('/svg/z-image.svg')
    expect(modelFamilyLogoSrc('Qwen-Image')).toBe('/svg/qwen-color.svg')
    expect(modelFamilyLogoSrc('Wan 2.2 TI2V 5B')).toBe('/svg/qwen-color.svg')
    expect(modelFamilyLogoSrc('Wan-AI/Wan2.2-TI2V-5B')).toBe(
      '/svg/qwen-color.svg'
    )
    expect(modelFamilyLogoSrc('Lightricks/LTX-2')).toBe('/svg/lightricks.svg')
    expect(modelFamilyLogoSrc('Lightricks/LTX-Video')).toBe(
      '/svg/lightricks.svg'
    )
  })

  it('does not hand text models an image-lab mark', () => {
    expect(modelFamilyLogoSrc('someone/Swan-7B-GGUF')).toBeNull()
    expect(modelFamilyLogoSrc('someone/influx-3b')).toBeNull()
  })

  it('ships the new marks as files and tints the single-color ones', async () => {
    const { existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const src of ['/svg/bfl.svg', '/svg/lightricks.svg']) {
      expect(existsSync(resolve(__dirname, '../../../public', `.${src}`))).toBe(
        true
      )
      expect(isMonochromeFamilyLogo(src)).toBe(true)
    }
  })
})

describe('isMonochromeFamilyLogo', () => {
  it('flags marks that must be tinted through a CSS mask', () => {
    expect(isMonochromeFamilyLogo('/svg/liquid.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/ibm.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/nousresearch.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/zai.svg')).toBe(true)
    expect(isMonochromeFamilyLogo('/svg/minimax.svg')).toBe(true)
    // A dark mark on transparency: a plain <img> loses it in dark mode.
    expect(isMonochromeFamilyLogo('/images/model-provider/prism-ml.webp')).toBe(
      true
    )
    expect(isMonochromeFamilyLogo('/images/model-provider/ling.webp')).toBe(
      false
    )
    expect(isMonochromeFamilyLogo('/svg/qwen-color.svg')).toBe(false)
    expect(isMonochromeFamilyLogo('/svg/ai2-color.svg')).toBe(false)
  })
})

describe('bundled Google mark', () => {
  it('ships the 2025 gradient "G", not the flat four-colour one', async () => {
    // Google redrew the "G" in May 2025: the four flat segments became one
    // continuous gradient. The resolver keeps the old path so nothing else
    // changes; the file behind it is what has to be current.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const svg = readFileSync(
      resolve(__dirname, '../../../public/svg/google-color.svg'),
      'utf8'
    )
    expect(svg).toContain('<linearGradient')
    expect(svg).not.toMatch(/#EA4335|#4285F4|#FBBC05|#34A853/i)
  })
})

describe('embedding model marks', () => {
  it('resolves the Gemma mark key without changing the Google one', () => {
    expect(iconKeyLogoSrc('gemma-mark')).toBe('/svg/gemma-color.svg')
    expect(iconKeyLogoSrc('gemma')).toBe('/svg/google-color.svg')
  })

  it('ships every embedding mark as a file', async () => {
    const { existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const key of ['gemma-mark', 'qwen', 'baai', 'nomic']) {
      const src = iconKeyLogoSrc(key) as string
      expect(
        existsSync(resolve(__dirname, '../../../public', `.${src}`)),
        key
      ).toBe(true)
    }
  })

  it('gives every catalog embedding model a bundled mark of its maker', () => {
    const { models } = getBaselineEmbeddingCatalog()
    for (const model of models) {
      expect(embeddingIconKey(model)).toBe(model.icon)
      expect(iconKeyLogoSrc(embeddingIconKey(model)), model.id).not.toBeNull()
    }
    expect(Object.fromEntries(models.map((m) => [m.id, m.icon]))).toEqual({
      'embeddinggemma-2': 'gemma-mark',
      'embeddinggemma-300m': 'gemma-mark',
      'qwen3-embedding-0.6b': 'qwen',
      'qwen3-vl-embedding-2b': 'qwen',
      'nomic-embed-text-v1.5': 'nomic',
      'bge-m3': 'baai',
    })
  })

  it("draws a downloaded bge or Nomic model with its maker's mark, BAAI's tinted like the other one-colour marks", () => {
    expect(modelFamilyLogoSrc('gpustack/bge-m3-GGUF')).toBe('/svg/baai.svg')
    expect(modelFamilyLogoSrc('BAAI/bge-small-en-v1.5')).toBe('/svg/baai.svg')
    expect(modelFamilyLogoSrc('nomic-ai/nomic-embed-text-v2-moe-GGUF')).toBe(
      '/images/model-provider/nomic.svg'
    )
    expect(isMonochromeFamilyLogo('/svg/baai.svg')).toBe(true)
    // Nomic's mark brings its own white square: drawn as it is.
    expect(isMonochromeFamilyLogo('/images/model-provider/nomic.svg')).toBe(
      false
    )
  })
})

describe('decision model marks', () => {
  it('gives every decision model with an icon a bundled mark', () => {
    for (const model of getBaselineDecisionCatalog().models) {
      const key = decisionIconKey(model)
      if (key) expect(iconKeyLogoSrc(key), model.id).not.toBeNull()
    }
  })

  it('falls back to Convai for a laya checkpoint only', () => {
    expect(decisionIconKey({ format: 'checkpoint' })).toBe('convai')
    expect(decisionIconKey({ format: 'checkpoint', icon: 'cloudflare' })).toBe(
      'cloudflare'
    )
    // A GGUF without a mark keeps the family logo or a letter, never someone else's.
    expect(decisionIconKey({ format: 'gguf' })).toBeUndefined()
  })
})
