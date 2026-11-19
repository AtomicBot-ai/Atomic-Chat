import { describe, expect, it } from 'vitest'
import { hubFormats } from '@/lib/hub-filters'
import { modelEngineIds } from '@/lib/hub-model-engines'
import { hubModelFacts } from '@/lib/hub-model-facts'
import { groupStrataCatalogRows, strataCatalogRows } from '../catalog'
import fixture from './fixtures/catalog.json'

describe('Strata Hub catalog', () => {
  it('keeps the recommended row ID and offers only quantizations for the selected backend', () => {
    const [base] = strataCatalogRows(fixture)
    const model = (variant_id: string, compatible_variants: string[]) => ({
      ...base,
      model_name: `strata/${variant_id}`,
      strata: { ...base.strata!, family: 'qwen38' as const, variant_id, compatible_variants },
    })
    const metal = 'macos-arm64-metal'
    const cuda = 'windows-x64-cuda13'
    const primary = model('iq3-xxs-dflash2', [metal, cuda])
    const lighter = model('q2-0-dflash2', [metal, cuda])
    const cudaOnly = model('iq2-xs-dflash2', [cuda])
    const models = [lighter, primary, cudaOnly]

    expect(groupStrataCatalogRows(models, metal)).toEqual([
      { ...primary, strataVariants: [lighter.strata, primary.strata] },
    ])
    expect(groupStrataCatalogRows(models, cuda)).toEqual([
      { ...primary, strataVariants: [lighter.strata, primary.strata, cudaOnly.strata] },
    ])
    expect(groupStrataCatalogRows(models)).toEqual([primary])
  })

  it('keeps different Flash-Next releases separate and groups the quants of one release', () => {
    const [base] = strataCatalogRows(fixture)
    const cuda = 'linux-x64-cuda13'
    const model = (variant_id: string, family: NonNullable<typeof base.strata>['family']) => ({
      ...base,
      model_name: `strata/${variant_id}`,
      strata: { ...base.strata!, family, variant_id, compatible_variants: [cuda] },
    })
    const original = model('iq3-xxs-dflash2', 'qwen38')
    const swift = model('swift-iq2-xs', 'qwen38')
    const swiftHeavy = model('swift-iq3-s', 'qwen38')
    const deepseek = model('ista-2-00bpw-dspark', 'deepseek41')
    const deepseekCoder = model('ista-coder-dspark', 'deepseek41')
    expect(groupStrataCatalogRows([original, swift, swiftHeavy, deepseek, deepseekCoder], cuda)).toEqual([
      original,
      { ...swift, strataVariants: [swift.strata, swiftHeavy.strata] },
      { ...deepseek, strataVariants: [deepseek.strata, deepseekCoder.strata] },
    ])
  })

  it('projects pinned variants with their full size and dedicated engine', () => {
    const [model] = strataCatalogRows(fixture)
    expect(model.model_name).toBe('strata/ud-q4-k-xl-mtp')
    expect(modelEngineIds(model)).toEqual(['strata'])
    expect(hubModelFacts(model, { budgetBytes: 100 })).toMatchObject({
      format: 'strata',
      sizeBytes: 23752946592,
      fit: undefined,
    })
  })

  it('has no fallback shelf for an ordinary GGUF', () => {
    expect(strataCatalogRows({ ...fixture, collections: {} })).toEqual([])
    expect(
      modelEngineIds({ model_name: 'test/Example-GGUF', downloads: 0 })
    ).not.toContain('strata')
    expect(hubFormats({ mlx: false, managed: [], strata: true })).toEqual([
      'gguf',
      'strata',
    ])
  })

  it('rejects a descriptor with a missing shard hash', () => {
    const invalid = structuredClone(fixture)
    invalid.models['strata-qwen36-ud-q4-k-xl'].definition.files[0].sha256 = ''
    expect(() => strataCatalogRows(invalid)).toThrow(
      /Invalid Strata descriptor/
    )
  })
})
