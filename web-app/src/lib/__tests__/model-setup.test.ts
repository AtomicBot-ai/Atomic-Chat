import { describe, expect, it } from 'vitest'

import {
  isFinalSetup,
  isRunningSetup,
  latestSetupFor,
  mergeSetup,
  parseHubFileUrl,
  requiresPrism,
  routeForVerdict,
  setupBytes,
  setupSteps,
} from '@/lib/model-setup'
import type {
  CompatibilityOutcome,
  CompatibilityVerdict,
  ModelSetup,
  ModelSetupPlan,
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
