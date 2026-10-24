/**
 * The pure pickers behind the first-run model list and the reply-model gate.
 *
 * They decide which file a first launch downloads and how a row says it fits
 * this machine — the choices the whole onboarding funnel is measured against —
 * and none of them had a test.
 */
import { describe, expect, it } from 'vitest'

import {
  describeRecommendationFit,
  fitLevel,
  formatMemoryGb,
  interleaveByPublisher,
  orderRowsByFit,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
  type FitLevel,
} from '@/containers/SetupScreenHelpers'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { CatalogModel, ModelQuant } from '@/services/models/types'

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

describe('fitLevel', () => {
  it('maps the four verdicts onto three colours and leaves "unknown" blank', () => {
    // Two verdicts share the yellow: `tight` and `spills` both mean "it will
    // run, expect less of it". `null` stays `null` — "we don't know" must not
    // be painted as a warning.
    expect(fitLevel('comfortable')).toBe('ok')
    expect(fitLevel('tight')).toBe('warn')
    expect(fitLevel('spills')).toBe('warn')
    expect(fitLevel('wont_load')).toBe('no')
    expect(fitLevel(null)).toBeNull()
    expect(fitLevel(undefined)).toBeNull()
  })
})

describe('orderRowsByFit', () => {
  type Row = { name: string; level: FitLevel | null }
  const row = (name: string, level: FitLevel | null): Row => ({ name, level })
  // Publisher is the first letter of the name: `q1`, `q2` are Qwen; `g1` Gemma.
  const keyOf = (r: Row) => r.name[0]
  const order = (rows: Row[], previous?: string) =>
    orderRowsByFit(rows, {
      levelOf: (r) => r.level,
      keyOf,
      interleave: interleaveByPublisher,
      previous,
    }).map((r) => r.name)

  it('lists what fits first, then what is tight, then what will not load, then the unknown', () => {
    expect(
      order([
        row('a1', null),
        row('b1', 'no'),
        row('c1', 'warn'),
        row('d1', 'ok'),
        row('e1', 'warn'),
        row('f1', 'ok'),
      ])
    ).toEqual(['d1', 'f1', 'c1', 'e1', 'b1', 'a1'])
  })

  it('still parts two neighbours from one publisher inside a colour group', () => {
    // Two Qwen and one Gemma that all fit: Qwen, Gemma, Qwen — not the
    // manifest's Qwen, Qwen, Gemma.
    expect(order([row('q1', 'ok'), row('q2', 'ok'), row('g1', 'ok')])).toEqual([
      'q1',
      'g1',
      'q2',
    ])
  })

  it('does not let the colour groups undo the interleave at their seam', () => {
    // The last green row is Qwen, so the first yellow row may not be.
    expect(
      order([row('q1', 'ok'), row('q2', 'warn'), row('g1', 'warn')])
    ).toEqual(['q1', 'g1', 'q2'])
  })

  it('starts away from the row above the list — the offer stays first and is not seated next to its twin', () => {
    // The offer is rendered above the picks, never dealt with them; its
    // publisher is passed as `previous` so the first green pick differs.
    expect(
      order([row('q1', 'ok'), row('g1', 'ok'), row('q2', 'warn')], 'q')
    ).toEqual(['g1', 'q1', 'q2'])
  })

  it('never reorders across groups to improve the interleave', () => {
    // Two Qwen that fit and one Gemma that will not: the Gemma stays last,
    // even though moving it up would part the two Qwen rows.
    expect(order([row('q1', 'ok'), row('q2', 'ok'), row('g1', 'no')])).toEqual([
      'q1',
      'q2',
      'g1',
    ])
    expect(order([])).toEqual([])
  })
})
