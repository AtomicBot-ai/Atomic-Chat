import { describe, expect, it } from 'vitest'
import {
  BASELINE_MODEL_CATALOG,
  RECOMMENDATION_LADDER,
  RECOMMENDED_MODEL_FALLBACKS,
} from '../models'
import { findPinnedQuant, parseFileSizeToBytes } from '@/lib/model-card'
import bundledRecommended from '@/registries/recommended-models.json'

/**
 * The ladder, its offline fallback cards and the bundled registry are three
 * hand-kept copies of one decision. They drift silently — a rung whose card is
 * missing paints a size-less placeholder, a pin no file matches downloads
 * whatever the selector picks — so they are checked against each other here.
 */
const GIB = 1024 ** 3
const rungs = Object.entries(RECOMMENDATION_LADDER)

describe('recommendation ladder', () => {
  it.each(rungs)('%s has a fallback card holding its pinned quant', (_, e) => {
    const card = RECOMMENDED_MODEL_FALLBACKS[e.repo]
    expect(card, `no fallback card for ${e.repo}`).toBeDefined()
    expect(findPinnedQuant(card.quants, e.quant)).toBeDefined()
    if (e.mmprojQuant) {
      expect(findPinnedQuant(card.mmproj_models, e.mmprojQuant)).toBeDefined()
    }
  })

  it.each(rungs)('%s states the size of what it downloads', (_, e) => {
    const card = RECOMMENDED_MODEL_FALLBACKS[e.repo]
    const weights = findPinnedQuant(card.quants, e.quant)!
    const projector = e.mmprojQuant
      ? findPinnedQuant(card.mmproj_models, e.mmprojQuant)
      : undefined
    const bytes =
      (parseFileSizeToBytes(weights.file_size) ?? 0) +
      (parseFileSizeToBytes(projector?.file_size) ?? 0)
    expect(bytes / GIB).toBeCloseTo(e.sizeGb, 1)
  })

  it('every rung is what the bundled registry recommends for that tier', () => {
    const tiers = (
      bundledRecommended as {
        tiers: Record<string, Array<{ model_name: string; quant?: string }>>
      }
    ).tiers
    for (const [tier, e] of rungs) {
      const names = (tiers[tier] ?? []).map((r) => r.model_name)
      expect(names, tier).toContain(e.repo)
    }
  })

  it('names no AtomicChat repository', () => {
    const repos = [
      ...rungs.map(([, e]) => e.repo),
      ...Object.keys(RECOMMENDED_MODEL_FALLBACKS),
      ...BASELINE_MODEL_CATALOG.map((m) => m.model_name),
      ...Object.values(RECOMMENDED_MODEL_FALLBACKS).flatMap((m) =>
        m.quants.map((q) => q.path)
      ),
    ]
    expect(repos.filter((r) => /atomicchat|atomicbot/i.test(r))).toEqual([])
  })
})
