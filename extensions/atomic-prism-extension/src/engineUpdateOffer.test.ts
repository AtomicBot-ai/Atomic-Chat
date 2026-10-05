import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ENGINE_UPDATE_AVAILABLE_EVENT,
  buildEngineUpdateOffer,
  clearEngineUpdateOffer,
  engineUpdateOfferKey,
  publishEngineUpdateOffer,
} from './engineUpdateOffer'

const CURRENT = 'prism-b10754-2459f68/linux-cuda-12.4-x64'
const TARGET = 'prism-b10800-aabbcc1/linux-cuda-12.4-x64'

describe('buildEngineUpdateOffer', () => {
  it('carries the core’s release page, note and size', () => {
    expect(
      buildEngineUpdateOffer('atomic-prism', CURRENT, TARGET, {
        notesUrl: 'https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10800-aabbcc1',
        notes: 'Faster Q1 kernels.',
        downloadSize: 512_000_000,
      })
    ).toEqual({
      provider: 'atomic-prism',
      currentBackend: CURRENT,
      targetBackend: TARGET,
      currentVersion: 'prism-b10754-2459f68',
      targetVersion: 'prism-b10800-aabbcc1',
      downloadSizeBytes: 512_000_000,
      restartRequired: false,
      releaseNotesUrl: 'https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10800-aabbcc1',
      notes: 'Faster Q1 kernels.',
    })
  })

  it.each([
    ['no details', {}],
    ['empty strings and a zero size', { notesUrl: '', notes: '', downloadSize: 0 }],
    ['values of the wrong type', { notesUrl: 1, notes: {}, downloadSize: '9' }],
  ])('guesses nothing with %s', (_label, details) => {
    const offer = buildEngineUpdateOffer('atomic-prism', CURRENT, TARGET, details as never)
    expect(offer).toMatchObject({ targetBackend: TARGET, restartRequired: false })
    expect(offer?.releaseNotesUrl).toBeUndefined()
    expect(offer?.notes).toBeUndefined()
    expect(offer?.downloadSizeBytes).toBeUndefined()
  })

  it.each(['', 'prism-b1', '/linux-cpu-x64', 'prism-b1/'])(
    'refuses a target it cannot describe: %j',
    (target) => {
      expect(buildEngineUpdateOffer('atomic-prism', CURRENT, target)).toBeNull()
    }
  )
})

describe('publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).dispatchEvent = vi.fn()
  })

  it('keys the offer by provider the way the web app reads it', () => {
    expect(engineUpdateOfferKey('atomic-prism')).toBe('atomic_engine_update_offer_atomic-prism')
    expect(ENGINE_UPDATE_AVAILABLE_EVENT).toBe('app:engine-update-available')
  })

  it('persists the offer and announces it', () => {
    const offer = buildEngineUpdateOffer('atomic-prism', CURRENT, TARGET)!
    publishEngineUpdateOffer(offer)

    expect(localStorage.setItem).toHaveBeenCalledWith(
      'atomic_engine_update_offer_atomic-prism',
      JSON.stringify(offer)
    )
    const event = vi.mocked((window as any).dispatchEvent).mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('app:engine-update-available')
    expect(event.detail).toEqual(offer)
  })

  it('still announces when storage throws', () => {
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw new Error('quota')
    })
    const offer = buildEngineUpdateOffer('atomic-prism', CURRENT, TARGET)!
    expect(() => publishEngineUpdateOffer(offer)).not.toThrow()
    const event = vi.mocked((window as any).dispatchEvent).mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual(offer)
  })

  it('retracts an offer, quietly when storage throws', () => {
    clearEngineUpdateOffer('atomic-prism')
    expect(localStorage.removeItem).toHaveBeenCalledWith('atomic_engine_update_offer_atomic-prism')

    vi.mocked(localStorage.removeItem).mockImplementationOnce(() => {
      throw new Error('gone')
    })
    expect(() => clearEngineUpdateOffer('atomic-prism')).not.toThrow()
  })
})
