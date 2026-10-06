import { describe, expect, it } from 'vitest'

import {
  currentSetupTask,
  isFinalSetup,
  isRunningSetup,
  isStandingReadySetup,
  latestSetupFor,
  mergeSetup,
  parseHubFileUrl,
  prismFamilyCard,
  prismFamilyCards,
  requiresPrism,
  routeForVerdict,
  setupBytes,
  setupSteps,
  setupsUnderWay,
} from '@/lib/model-setup'
import type {
  CompatibilityOutcome,
  CompatibilityVerdict,
  ModelSetup,
  ModelSetupPlan,
  PrismFamily,
} from '@/services/model-setup/types'

const verdict = (
  outcome: CompatibilityOutcome,
  provider: string | null = null
): CompatibilityVerdict => ({
  outcome,
  provider,
  requires: [],
  evidence: 'rules',
  rules_version: 1,
  reason: 'r',
})

const plan = (overrides: Partial<ModelSetupPlan> = {}): ModelSetupPlan => ({
  digest: 'd',
  model_id: 'prism-ml/Bonsai-8B-PQ2_0',
  provider: 'atomic-prism',
  verdict: verdict('engine_required', 'atomic-prism'),
  engine: {
    provider: 'atomic-prism',
    version: 'prism-b9000-abcdef0',
    backend: 'macos-arm64',
    installed: false,
    download_size: 100,
  },
  model: {
    repo: 'prism-ml/Bonsai',
    file: 'm.gguf',
    revision: 'main',
    size: 1000,
  },
  projector: {
    repo: 'prism-ml/Bonsai',
    file: 'p.gguf',
    revision: 'main',
    size: 10,
  },
  total_download_bytes: 1110,
  free_bytes: 10_000,
  blockers: [],
  ...overrides,
})

const setup = (overrides: Partial<ModelSetup> = {}): ModelSetup => ({
  setup_id: 's1',
  request_id: 'r1',
  revision: 1,
  stage: 'queued',
  request: { repo: 'prism-ml/Bonsai', file: 'm.gguf' },
  plan: plan(),
  task_ids: { engine: 'te', model: 'tm', projector: 'tp' },
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

describe('parseHubFileUrl', () => {
  it.each([
    [
      'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-PQ2_0.gguf',
      {
        repo: 'prism-ml/Bonsai-8B-gguf',
        file: 'Bonsai-8B-PQ2_0.gguf',
        revision: 'main',
      },
    ],
    [
      'https://huggingface.co/o/r/resolve/abc123/sub/dir/f%20x.gguf?download=true',
      { repo: 'o/r', file: 'sub/dir/f x.gguf', revision: 'abc123' },
    ],
    ['https://example.test/o/r/resolve/main/f.gguf', null],
    ['https://huggingface.co/o/r/blob/main/f.gguf', null],
    ['https://huggingface.co/o/r/resolve/main', null],
    ['/Users/me/models/f.gguf', null],
  ])('%s', (url, expected) => {
    expect(parseHubFileUrl(url)).toEqual(expected)
  })
})

describe('routeForVerdict', () => {
  it.each([
    [verdict('engine_required', 'atomic-prism'), 'setup'],
    [verdict('engine_update_required', 'atomic-prism'), 'setup'],
    [verdict('compatible', 'atomic-prism'), 'setup'],
    [verdict('compatible'), 'download'],
    [verdict('compatible', 'llamacpp-upstream'), 'download'],
    [verdict('legacy_artifact'), 'refuse'],
    [verdict('unsupported'), 'refuse'],
    [verdict('inspection_required'), 'download'],
  ] as const)('%o → %s', (input, expected) => {
    expect(routeForVerdict(input)).toBe(expected)
  })

  it('marks only the files that need PrismML', () => {
    expect(requiresPrism(verdict('engine_required', 'atomic-prism'))).toBe(true)
    expect(requiresPrism(verdict('compatible'))).toBe(false)
    expect(requiresPrism(verdict('legacy_artifact'))).toBe(false)
    expect(requiresPrism(null)).toBe(false)
    expect(requiresPrism(undefined)).toBe(false)
  })
})

describe('setup stages', () => {
  it.each([
    ['queued', false, true],
    ['downloading_model', false, true],
    ['interrupted', false, false],
    ['ready', true, false],
    ['failed', true, false],
    ['cancelled', true, false],
  ] as const)('%s: final=%s running=%s', (stage, final, running) => {
    expect(isFinalSetup(setup({ stage }))).toBe(final)
    expect(isRunningSetup(setup({ stage }))).toBe(running)
  })

  it('walks only the stages the plan needs', () => {
    expect(setupSteps(setup())).toEqual([
      'queued',
      'installing_engine',
      'downloading_model',
      'downloading_projector',
      'verifying',
      'registering',
      'ready',
    ])
    const installed = plan({
      engine: { ...plan().engine!, installed: true },
      projector: null,
    })
    expect(setupSteps({ plan: installed })).toEqual([
      'queued',
      'downloading_model',
      'verifying',
      'registering',
      'ready',
    ])
  })
})

describe('isStandingReadySetup', () => {
  const launch = 100
  const ready = (updated_at: number) => setup({ stage: 'ready', updated_at })

  it('stands for an installed model', () => {
    expect(
      isStandingReadySetup(
        ready(1),
        { installed: true, deleted: false },
        launch
      )
    ).toBe(true)
  })

  it('ends once the app deleted the model, however recent', () => {
    expect(
      isStandingReadySetup(
        ready(200),
        { installed: true, deleted: true },
        launch
      )
    ).toBe(false)
  })

  it('stands for a model ready since this launch that is not listed yet', () => {
    expect(
      isStandingReadySetup(
        ready(200),
        { installed: false, deleted: false },
        launch
      )
    ).toBe(true)
  })

  it('ends when a setup from before this launch left no model', () => {
    expect(
      isStandingReadySetup(
        ready(1),
        { installed: false, deleted: false },
        launch
      )
    ).toBe(false)
  })

  it('is never true for a setup that is not ready', () => {
    expect(
      isStandingReadySetup(
        setup({ stage: 'failed', updated_at: 200 }),
        { installed: true, deleted: false },
        launch
      )
    ).toBe(false)
  })
})

describe('setupsUnderWay', () => {
  it('lists the newest setup of each file while it runs or waits, oldest first', () => {
    const replaced = setup({
      setup_id: 'a',
      stage: 'interrupted',
      created_at: 1,
      updated_at: 1,
    })
    const retried = setup({
      setup_id: 'b',
      stage: 'downloading_model',
      created_at: 5,
      updated_at: 6,
    })
    const waiting = setup({
      setup_id: 'c',
      stage: 'interrupted',
      created_at: 2,
      updated_at: 2,
      request: { repo: 'prism-ml/Bonsai', file: 'other.gguf' },
    })
    expect(
      setupsUnderWay([retried, replaced, waiting]).map((s) => s.setup_id)
    ).toEqual(['c', 'b'])
  })

  it('leaves out a file whose newest setup ended', () => {
    const failed = setup({ setup_id: 'a', stage: 'failed', updated_at: 1 })
    const ready = setup({ setup_id: 'b', stage: 'ready', updated_at: 2 })
    expect(setupsUnderWay([failed, ready])).toEqual([])
  })
})

describe('currentSetupTask', () => {
  it.each([
    ['installing_engine', 'te'],
    ['downloading_model', 'tm'],
    ['downloading_projector', 'tp'],
    ['verifying', undefined],
    ['interrupted', undefined],
  ] as const)('%s downloads with %s', (stage, task) => {
    expect(currentSetupTask(setup({ stage }))).toBe(task)
  })
})

describe('mergeSetup', () => {
  it('keeps the highest revision', () => {
    const newer = setup({ revision: 3, stage: 'verifying' })
    const merged = mergeSetup({ s1: newer }, setup({ revision: 2 }))
    expect(merged.s1).toBe(newer)
    expect(
      mergeSetup(merged, setup({ revision: 4, stage: 'ready' })).s1.stage
    ).toBe('ready')
    expect(mergeSetup({}, setup()).s1.revision).toBe(1)
  })
})

describe('latestSetupFor', () => {
  it('finds the newest setup of the same repository file', () => {
    const old = setup({ setup_id: 'a', updated_at: 1 })
    const recent = setup({ setup_id: 'b', updated_at: 5 })
    const other = setup({
      setup_id: 'c',
      updated_at: 9,
      request: { repo: 'prism-ml/Bonsai', file: 'other.gguf' },
    })
    const file = { repo: 'prism-ml/Bonsai', file: 'm.gguf' }
    expect(latestSetupFor([old, recent, other], file)).toBe(recent)
    expect(latestSetupFor([other], file)).toBeUndefined()
  })
})

describe('setupBytes', () => {
  it('counts finished downloads in full and the running one as reported', () => {
    expect(setupBytes(setup({ stage: 'queued' }), {})).toEqual({
      transferred: 0,
      total: 1110,
    })
    expect(
      setupBytes(setup({ stage: 'installing_engine' }), {
        te: { transferred: 40, total: 100 },
      })
    ).toEqual({ transferred: 40, total: 1110 })
    expect(
      setupBytes(setup({ stage: 'downloading_model' }), {
        tm: { transferred: 2000, total: 1000 },
      })
    ).toEqual({ transferred: 1100, total: 1110 })
    expect(setupBytes(setup({ stage: 'verifying' }), {})).toEqual({
      transferred: 1110,
      total: 1110,
    })
  })

  it('stops where an interrupted setup stopped', () => {
    expect(
      setupBytes(
        setup({ stage: 'interrupted', stopped_at: 'downloading_projector' }),
        { tp: { transferred: 4, total: 10 } }
      )
    ).toEqual({ transferred: 1104, total: 1110 })
  })

  it('takes the size from the task when the Hub did not say', () => {
    const unsized = setup({
      stage: 'downloading_model',
      plan: plan({
        engine: null,
        projector: null,
        model: { ...plan().model, size: 0 },
      }),
    })
    expect(setupBytes(unsized, { tm: { transferred: 5, total: 50 } })).toEqual({
      transferred: 5,
      total: 50,
    })
  })
})

describe('Bonsai families as Hub cards', () => {
  const family = (over: Partial<PrismFamily> = {}): PrismFamily => ({
    id: 'ternary-bonsai-2-27b',
    title: 'Ternary Bonsai 2 27B',
    repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
    revision: 'b072e1d',
    files: [
      {
        file: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
        size: 5_946_648_928,
        sha256: 'a'.repeat(64),
        treatment: 'prism_required',
      },
      {
        file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
        size: 7_206_168_928,
        sha256: 'b'.repeat(64),
        treatment: 'prism_required',
        default: true,
      },
    ],
    projectors: [
      {
        file: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
        size: 629_246_976,
        sha256: 'c'.repeat(64),
        default: true,
      },
    ],
    ...over,
  })

  it('offers the recommended file first, pinned to the family revision', () => {
    const card = prismFamilyCard(family())

    expect(card).toMatchObject({
      model_name: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      developer: 'prism-ml',
      description: 'Ternary Bonsai 2 27B',
      num_quants: 2,
    })
    expect(card.quants?.map((q) => q.model_id)).toEqual([
      'prism-ml/Ternary-Bonsai-2-27B-PQ2_0',
      'prism-ml/Ternary-Bonsai-2-27B-PTQ1_0',
    ])
    expect(card.quants?.[0]).toMatchObject({
      path: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/b072e1d/Ternary-Bonsai-2-27B-PQ2_0.gguf',
      file_size: '6.7 GB',
    })
    expect(card.mmproj_models?.[0].file_size).toBe('600.1 MB')
    // The URL is what the verdict and the setup read the file from.
    expect(parseHubFileUrl(card.quants![0].path)).toEqual({
      repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      revision: 'b072e1d',
    })
  })

  it('lists the featured families first', () => {
    const cards = prismFamilyCards([
      family({ id: 'a', repo: 'prism-ml/Bonsai-8B-gguf' }),
      family({ id: 'b', featured: true }),
    ])

    expect(cards.map((c) => c.model_name)).toEqual([
      'prism-ml/Ternary-Bonsai-2-27B-gguf',
      'prism-ml/Bonsai-8B-gguf',
    ])
  })
})
