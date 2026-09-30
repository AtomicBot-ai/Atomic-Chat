import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearEngineUpdateOffer,
  dismissEngineUpdate,
  engineUpdateOfferKey,
  isEngineUpdateSnoozed,
  readEngineUpdateOffer,
  snoozeEngineUpdate,
  ENGINE_UPDATE_SNOOZE_MS,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'

const OFFER: EngineUpdateOffer = {
  provider: 'llamacpp-upstream',
  currentBackend: 'b10840/macos-arm64',
  targetBackend: 'b10909/macos-arm64',
  currentVersion: 'b10840',
  targetVersion: 'b10909',
  downloadSizeBytes: 11 * 1024 * 1024,
  restartRequired: false,
  releaseNotesUrl: 'https://example.test/b10909',
}

const NOW = 1_700_000_000_000

describe('engine update offer storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips an offer an extension wrote', () => {
    localStorage.setItem(
      engineUpdateOfferKey(OFFER.provider),
      JSON.stringify(OFFER)
    )
    expect(readEngineUpdateOffer(OFFER.provider)).toEqual(OFFER)
  })

  it('ignores a payload missing the fields the banner needs', () => {
    localStorage.setItem(
      engineUpdateOfferKey('llamacpp'),
      JSON.stringify({ provider: 'llamacpp' })
    )
    expect(readEngineUpdateOffer('llamacpp')).toBeNull()
  })

  it('ignores unparseable storage rather than throwing', () => {
    localStorage.setItem(engineUpdateOfferKey('llamacpp'), '{not json')
    expect(readEngineUpdateOffer('llamacpp')).toBeNull()
  })

  it('clears an offer', () => {
    localStorage.setItem(
      engineUpdateOfferKey(OFFER.provider),
      JSON.stringify(OFFER)
    )
    clearEngineUpdateOffer(OFFER.provider)
    expect(readEngineUpdateOffer(OFFER.provider)).toBeNull()
  })
})

describe('engine update snoozing', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows an offer nobody has put away', () => {
    expect(isEngineUpdateSnoozed(OFFER, NOW)).toBe(false)
  })

  it('keeps "remind me later" down for a day, then lets it back', () => {
    snoozeEngineUpdate(OFFER, NOW)

    expect(isEngineUpdateSnoozed(OFFER, NOW + 1)).toBe(true)
    expect(
      isEngineUpdateSnoozed(OFFER, NOW + ENGINE_UPDATE_SNOOZE_MS - 1)
    ).toBe(true)
    expect(
      isEngineUpdateSnoozed(OFFER, NOW + ENGINE_UPDATE_SNOOZE_MS + 1)
    ).toBe(false)
  })

  it('keeps a dismissed build away for good', () => {
    dismissEngineUpdate(OFFER)

    expect(isEngineUpdateSnoozed(OFFER, NOW)).toBe(true)
    expect(
      isEngineUpdateSnoozed(OFFER, NOW + 365 * ENGINE_UPDATE_SNOOZE_MS)
    ).toBe(true)
  })

  it('gives the next build a fresh hearing after a dismissal', () => {
    dismissEngineUpdate(OFFER)

    const newer: EngineUpdateOffer = {
      ...OFFER,
      targetBackend: 'b11000/macos-arm64',
      targetVersion: 'b11000',
    }
    expect(isEngineUpdateSnoozed(newer, NOW)).toBe(false)
  })

  it("keeps each provider's decision to itself", () => {
    dismissEngineUpdate(OFFER)

    const turboquant: EngineUpdateOffer = { ...OFFER, provider: 'llamacpp' }
    expect(isEngineUpdateSnoozed(turboquant, NOW)).toBe(false)
    expect(isEngineUpdateSnoozed(OFFER, NOW)).toBe(true)
  })
})
