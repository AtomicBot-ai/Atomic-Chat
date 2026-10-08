import {
  dismissEngineUpdate,
  engineReleaseNotesUrl,
  engineUpdateOfferFrom,
  isEngineUpdateSnoozed,
  snoozeEngineUpdate,
  ENGINE_UPDATE_SNOOZE_MS,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import type { EngineVersions } from '@/services/engines/types'

const OFFER: EngineUpdateOffer = {
  provider: 'llamacpp-upstream',
  currentBackend: 'b10840/macos-arm64',
  targetBackend: 'b10909/macos-arm64',
  currentVersion: 'b10840',
  targetVersion: 'b10909',
  downloadSizeBytes: 11 * 1024 * 1024,
  apply: 'swap',
  restartRequired: false,
  releaseNotesUrl: 'https://example.test/b10909',
}

const NOW = 1_700_000_000_000

const versions = (patch: Partial<EngineVersions> = {}): EngineVersions => ({
  engine: 'llamacpp-upstream',
  kind: 'llamacpp',
  active_choice: 'client',
  builds: [],
  active: { version: 'b10840', variant: 'macos-arm64' },
  latest: null,
  update: {
    needed: true,
    target: { version: 'b10909', variant: 'macos-arm64', download_bytes: 0 },
    apply: 'swap',
  },
  source: 'remote',
  source_error: null,
  error: null,
  ...patch,
})

describe('engineUpdateOfferFrom', () => {
  it('turns what the core says is needed into the banner’s offer', () => {
    expect(engineUpdateOfferFrom(versions())).toEqual({
      provider: 'llamacpp-upstream',
      currentBackend: 'b10840/macos-arm64',
      targetBackend: 'b10909/macos-arm64',
      currentVersion: 'b10840',
      targetVersion: 'b10909',
      // A zero size is "unknown", not "0 bytes".
      downloadSizeBytes: undefined,
      apply: 'swap',
      restartRequired: false,
      releaseNotesUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b10909',
    })
  })

  it('makes no offer the core does not make, nor one without an active build', () => {
    expect(
      engineUpdateOfferFrom(
        versions({
          update: {
            needed: false,
            target: { version: 'b10909', variant: 'macos-arm64' },
            apply: 'swap',
            blocked_reason: 'source-unavailable',
          },
        })
      )
    ).toBeNull()
    expect(engineUpdateOfferFrom(versions({ active: null }))).toBeNull()
  })
})

describe('engineReleaseNotesUrl', () => {
  it('links each engine whose release page follows from its tag', () => {
    expect(engineReleaseNotesUrl('llamacpp', 'b10018-1.3.0')).toBe(
      'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/b10018-1.3.0'
    )
    expect(engineReleaseNotesUrl('mlx', 'mlxvlm-macos-arm64-abc1234')).toBe(
      'https://github.com/AtomicBot-ai/mlx-vlm/releases/tag/mlxvlm-macos-arm64-abc1234'
    )
    expect(engineReleaseNotesUrl('sd-cpp', 'master-900-abc1234')).toBe(
      'https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-900-abc1234'
    )
    // The fork's build links the fork's release of its upstream tag.
    expect(engineReleaseNotesUrl('sd-cpp', 'master-883-137f740-a36f1b1a')).toBe(
      'https://github.com/AtomicBot-ai/stable-diffusion.cpp/releases/tag/master-883-137f740'
    )
    expect(engineReleaseNotesUrl('atomic-prism', 'prism-b9100-1234567')).toBeUndefined()
    expect(engineReleaseNotesUrl('vllm', 'vllm-0.32.0-r1')).toBeUndefined()
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
