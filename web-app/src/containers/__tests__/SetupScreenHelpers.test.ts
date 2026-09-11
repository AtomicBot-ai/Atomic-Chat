/**
 * The pure pickers behind the first-run screen.
 *
 * They decide which file a first launch downloads, which one auto-starts, and
 * which screen the flow opens on — the choices the whole onboarding funnel is
 * measured against — and none of them had a test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  describeRecommendationFit,
  formatDetectedSize,
  formatMemoryGb,
  getInitialStep,
  interleaveByPublisher,
  pickAutoRunCandidate,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
  sizeStringToGb,
} from '@/containers/SetupScreen'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import type { LocalModelCandidate } from '@/services/models/localScan'

const quant = (model_id: string): ModelQuant =>
  ({
    model_id,
    path: `https://example.test/${model_id}`,
    file_size: '1 GB',
  }) as ModelQuant

const catalog = (quants: ModelQuant[]): CatalogModel =>
  ({ model_name: 'vendor/model', quants }) as CatalogModel

describe('pickPreferredVariant', () => {
  it('honours a manifest pin over the default quant preference', () => {
    // LFM2.5-VL-450M needs Q8_0, and the repo also offers a Q4_K_M that the
    // default list matches: without the pin a working but wrong file is
    // downloaded and nothing anywhere reports it.
    const model = catalog([quant('model-Q4_K_M'), quant('model-Q8_0')])

    expect(pickPreferredVariant(model, 'Q8_0')?.model_id).toBe('model-Q8_0')
  })

  it('falls back to the default preference, then to whatever exists', () => {
    expect(
      pickPreferredVariant(catalog([quant('model-F16'), quant('model-Q4_K_M')]))
        ?.model_id
    ).toBe('model-Q4_K_M')

    expect(pickPreferredVariant(catalog([quant('model-F16')]))?.model_id).toBe(
      'model-F16'
    )

    expect(pickPreferredVariant(catalog([]))).toBeNull()
  })
})

describe('pickMmprojModel', () => {
  it('honours a pin the literal-id lookup would miss', () => {
    // `getPreferredMmprojModel` looks for the literal id `mmproj-f16`, so
    // LiquidAI's `mmproj-LFM2_5-VL-450m-F16` never matched and it silently
    // took the first entry — BF16 at 181 MB instead of Q8_0 at 98 MB.
    const model = {
      model_name: 'vendor/model',
      mmproj_models: [
        { model_id: 'mmproj-LFM2_5-VL-450m-BF16' },
        { model_id: 'mmproj-LFM2_5-VL-450m-Q8_0' },
      ],
    } as unknown as CatalogModel

    expect(pickMmprojModel(model, 'Q8_0')?.model_id).toBe(
      'mmproj-LFM2_5-VL-450m-Q8_0'
    )
  })
})

describe('formatDetectedSize', () => {
  it('switches unit at a gigabyte and refuses to invent a size', () => {
    expect(formatDetectedSize(5 * 1024 ** 3)).toBe('5.00 GB')
    expect(formatDetectedSize(850 * 1024 ** 2)).toBe('850 MB')
    expect(formatDetectedSize(0)).toBeNull()
    expect(formatDetectedSize(undefined)).toBeNull()
  })

  it('never shows a detected model as 0 MB', () => {
    expect(formatDetectedSize(1)).toBe('1 MB')
  })
})

describe('sizeStringToGb', () => {
  it('parses the catalog strings that feed size_gb', () => {
    expect(sizeStringToGb('4.5 GB')).toBe(4.5)
    expect(sizeStringToGb('850 MB')).toBe(0.83)
    expect(sizeStringToGb('2GB')).toBe(2)
  })

  it('returns undefined rather than a wrong number', () => {
    expect(sizeStringToGb(undefined)).toBeUndefined()
    expect(sizeStringToGb('unknown')).toBeUndefined()
    expect(sizeStringToGb('4.5 TB')).toBeUndefined()
  })
})

describe('pickAutoRunCandidate', () => {
  const cand = (
    id: string,
    runnable: boolean,
    sizeBytes?: number
  ): LocalModelCandidate => ({ id, runnable, sizeBytes }) as LocalModelCandidate

  it('picks the smallest runnable model, so the first launch feels instant', () => {
    expect(
      pickAutoRunCandidate([
        cand('big', true, 9_000_000_000),
        cand('small', true, 1_000_000_000),
      ])?.id
    ).toBe('small')
  })

  it('prefers a measured model over an unmeasured one', () => {
    expect(
      pickAutoRunCandidate([cand('unknown', true), cand('known', true, 9e9)])
        ?.id
    ).toBe('known')
  })

  it('never auto-starts something that cannot run', () => {
    // LoRA adapters are listed but need a base model first.
    expect(pickAutoRunCandidate([cand('adapter', false, 1)])).toBeNull()
    expect(pickAutoRunCandidate([])).toBeNull()
  })
})

describe('getInitialStep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('opens on the backend step only on a first Windows launch', () => {
    vi.stubGlobal('IS_WINDOWS', true)
    vi.stubGlobal('IS_LINUX', false)
    expect(getInitialStep()).toBe('backend')

    // Set by `handleBackendStepDone` — and, since ATO-459, before a
    // "Restart now" too, which previously showed the step a second time.
    localStorage.setItem('llama_cpp_onboarding_done', 'downloaded')
    expect(getInitialStep()).toBe('model')
  })

  it('opens on the backend step on a first Linux launch too', () => {
    // Linux installs on the CPU build with a Vulkan build to offer, exactly
    // the situation the step exists for (ATO-464).
    vi.stubGlobal('IS_WINDOWS', false)
    vi.stubGlobal('IS_LINUX', true)
    expect(getInitialStep()).toBe('backend')

    localStorage.setItem('llama_cpp_onboarding_done', 'skipped')
    expect(getInitialStep()).toBe('model')
  })

  it('goes straight to the picker on macOS', () => {
    vi.stubGlobal('IS_WINDOWS', false)
    vi.stubGlobal('IS_LINUX', false)
    expect(getInitialStep()).toBe('model')
  })
})

describe('formatMemoryGb', () => {
  it('rounds to what the owner would call their machine', () => {
    expect(formatMemoryGb(16 * 1024)).toBe('16 GB')
    // A 16 GB Mac that reports a little under its badge still reads as 16.
    expect(formatMemoryGb(15 * 1024 + 900)).toBe('16 GB')
    expect(formatMemoryGb(0)).toBeNull()
    expect(formatMemoryGb(undefined)).toBeNull()
  })
})

describe('describeRecommendationFit', () => {
  const profile = (over: Partial<HardwareProfile>): HardwareProfile => ({
    tier: 'unified_16',
    memoryKind: 'unified',
    budgetMib: 16 * 1024,
    systemRamMib: 16 * 1024,
    vramMib: 0,
    hardCeiling: true,
    ...over,
  })

  it('names the pool, because 16 GB of VRAM is not 16 GB of RAM', () => {
    expect(
      describeRecommendationFit({
        sizeLabel: '2.52 GB',
        sizeBytes: 2.52 * 1024 ** 3,
        profile: profile({}),
      })
    ).toEqual({
      key: 'setup:recommend.whyComfortable',
      values: { size: '2.52 GB', budget: '16 GB' },
      poolKey: 'setup:recommend.pool.unified',
    })
  })

  it('reads a CPU-only machine by its CPU, not by its RAM', () => {
    // Quoting "fits your 128 GB" here would explain the wrong constraint: what
    // binds a machine with no accelerator is token throughput.
    expect(
      describeRecommendationFit({
        sizeLabel: '0.68 GB',
        sizeBytes: 0.68 * 1024 ** 3,
        profile: profile({ memoryKind: 'system', budgetMib: 128 * 1024 }),
      })
    ).toEqual({
      key: 'setup:recommend.whyCpuOnly',
      values: { size: '0.68 GB' },
    })
  })

  it('says the model will not load past the measured macOS ceiling', () => {
    // The offer itself steps down a rung before this can show (see
    // useResolvedRecommendedModels); the caption is the last line of defence
    // for a card whose size resolved after the rung was chosen.
    expect(
      describeRecommendationFit({
        sizeLabel: '15.00 GB',
        sizeBytes: 15 * 1024 ** 3,
        profile: profile({}),
      })?.key
    ).toBe('setup:recommend.whyWontLoad')
  })

  it('calls the same overshoot a slowdown on a card', () => {
    expect(
      describeRecommendationFit({
        sizeLabel: '15.00 GB',
        sizeBytes: 15 * 1024 ** 3,
        profile: profile({
          memoryKind: 'vram',
          hardCeiling: false,
          budgetMib: 8 * 1024,
        }),
      })?.key
    ).toBe('setup:recommend.whySpills')
  })

  it('falls back to a claim it can actually support when hardware is unknown', () => {
    expect(
      describeRecommendationFit({
        sizeLabel: '0.68 GB',
        sizeBytes: 0.68 * 1024 ** 3,
        profile: null,
      })
    ).toEqual({
      key: 'setup:recommend.whyUnknown',
      values: { size: '0.68 GB' },
    })
  })

  it('says nothing at all without a size', () => {
    expect(
      describeRecommendationFit({ sizeLabel: null, profile: profile({}) })
    ).toBeNull()
  })
})

describe('publisherKey', () => {
  it('names the brand a row will wear, whatever repo it ships from', () => {
    // Most picks are our own repacks, so the repo owner says nothing about
    // who made the model; the brand mark does.
    expect(publisherKey('AtomicChat/gemma-4-12B-it-GGUF', 'gemma')).toBe(
      publisherKey('google/gemma-4-E2B-it-GGUF', 'google')
    )
    expect(publisherKey('AtomicChat/Qwen3.6-27B-GGUF')).toBe(
      publisherKey('unsloth/Qwen3.5-35B-A3B-GGUF', 'qwen')
    )
    expect(publisherKey('AtomicChat/Muse-Glimmer-30B-GGUF', 'meta')).toBe(
      publisherKey('unsloth/Llama-3.2-3B-Instruct-GGUF')
    )
  })

  it('falls back to the repo owner for a brand it has no mark for', () => {
    expect(publisherKey('SomeLab/Foo-7B-GGUF')).toBe('somelab')
  })
})

describe('interleaveByPublisher', () => {
  const key = (row: string) => row[0]

  it('keeps the given order except to part two neighbours from one publisher', () => {
    expect(interleaveByPublisher(['a1', 'a2', 'b1', 'a3', 'c1'], key)).toEqual([
      'a1',
      'b1',
      'a2',
      'c1',
      'a3',
    ])
  })

  it('starts away from the publisher of the row above the list', () => {
    expect(interleaveByPublisher(['a1', 'a2', 'b1'], key, 'a')).toEqual([
      'b1',
      'a1',
      'a2',
    ])
  })

  it('lets one publisher run on only when nothing else is left', () => {
    expect(interleaveByPublisher(['a1', 'a2', 'a3'], key)).toEqual([
      'a1',
      'a2',
      'a3',
    ])
    expect(interleaveByPublisher([], key)).toEqual([])
  })
})
