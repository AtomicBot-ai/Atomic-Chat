import { expect, it } from 'vitest'
import { atomicModelCatalogBaseline } from '@janhq/core'
import { pinnedRecommendationModel } from '../hf-catalog'
import { sanitizeRecommendation } from '@/services/recommended-models-registry'
import { sanitizePick } from '@/services/staff-picks-registry'
import type { CatalogModel } from '../types'

it('keeps discovery and the managed recommendation for one repository at independent commits', () => {
  const entry = Object.values(atomicModelCatalogBaseline().models).find(
    (entry) => entry.kind === 'chat'
  )!
  const repo = String(entry.definition.model_name)
  const revision = String(entry.definition.revision)
  const discovery: CatalogModel = {
    model_name: repo,
    revision: 'b'.repeat(40),
    description: '',
    downloads: 10,
    quants: [],
  }
  const sources = [discovery]
  expect(pinnedRecommendationModel(sources, repo)).toBe(discovery)
  const recommended = pinnedRecommendationModel(sources, repo, revision)!
  expect(recommended.revision).toBe(revision)
  expect(recommended.quants.length).toBeGreaterThan(0)
  expect(
    recommended.quants.every((quant) =>
      quant.path.includes(`/resolve/${revision}/`)
    )
  ).toBe(true)
  expect(sources).toEqual([discovery])
  expect(discovery.revision).toBe('b'.repeat(40))
})

it('retains explicit managed revisions through recommendation and staff-pick adapters', () => {
  const revision = 'a'.repeat(40)
  expect(
    sanitizeRecommendation({
      model_name: 'o/r',
      description_key: 'hub:test',
      revision,
    })?.revision
  ).toBe(revision)
  expect(sanitizePick({ model_name: 'o/r', revision })?.revision).toBe(revision)
})

it('refuses to satisfy a pinned recommendation with another discovery revision', () => {
  const sources: CatalogModel[] = [
    {
      model_name: 'outside/model',
      revision: 'b'.repeat(40),
      description: '',
      downloads: 1,
      quants: [],
    },
  ]
  expect(
    pinnedRecommendationModel(sources, 'outside/model', 'a'.repeat(40))
  ).toBeUndefined()
})

it('rejects malformed explicit revisions rather than treating them as floating recommendations', () => {
  expect(
    sanitizeRecommendation({
      model_name: 'o/r',
      description_key: 'hub:test',
      revision: 'main',
    })
  ).toBeNull()
  expect(sanitizePick({ model_name: 'o/r', revision: 'main' })).toBeNull()
})
