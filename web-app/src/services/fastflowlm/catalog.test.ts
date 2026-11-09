import { describe, expect, it } from 'vitest'
import { atomicModelCatalogBaseline } from '@janhq/core'
import { fastFlowLmModels } from './catalog'

describe('FastFlowLM collection in the shared catalog', () => {
  it('keeps an accepted older catalog without FLM empty', () => {
    const catalog = structuredClone(atomicModelCatalogBaseline())
    delete catalog.collections['fastflowlm-models']
    expect(fastFlowLmModels(catalog)).toEqual([])
  })

  it('offers the full offline collection with editorial recommendations first', () => {
    const models = fastFlowLmModels(atomicModelCatalogBaseline())
    expect(models).toHaveLength(44)
    expect(models.filter((model) => model.recommended)).toHaveLength(10)
    expect(models.slice(0, 10).every((model) => model.recommended)).toBe(true)
    expect(
      models.some((model) => model.qualification.status === 'upstream')
    ).toBe(true)
    for (const model of models) {
      expect(
        model.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))
      ).toBe(true)
      expect(
        model.sources.every((source) => /^[a-f0-9]{40}$/.test(source.revision))
      ).toBe(true)
    }
  })
})
