import { beforeEach, describe, expect, it, vi } from 'vitest'

import gemmaRevision from './fixtures/hf-revision-gemma-4-E2B-it-litert-lm.json'
import listing from './fixtures/hf-listing-litert-community.json'
import qwenRevision from './fixtures/hf-revision-Qwen3-4B.json'
import {
  classifyLiteRtFile,
  fetchHfLiteRtModels,
  hfVariants,
  resetHfLiteRtCache,
  uniqueHfIds,
} from '../huggingface'

// Recorded answers of the Hugging Face API (22 October 2026, trimmed): the `litert-lm` listing of
// `litert-community` and two repositories at the commit `main` named then.
const HUB = 'https://huggingface.co'

function hub(overrides: Record<string, unknown> = {}) {
  const asked: string[] = []
  const fetchJson = vi.fn(async (url: string) => {
    asked.push(url)
    if (url in overrides) {
      const answer = overrides[url]
      if (answer instanceof Error) throw answer
      return answer
    }
    if (url.startsWith(`${HUB}/api/models?`)) return listing
    if (url === `${HUB}/api/models/litert-community/gemma-4-E2B-it-litert-lm/revision/main?blobs=true`) {
      return gemmaRevision
    }
    if (url === `${HUB}/api/models/litert-community/Qwen3-4B/revision/main?blobs=true`) return qwenRevision
    throw new Error(`not recorded: ${url}`)
  })
  return { fetchJson, asked }
}

const base = {
  orgs: ['litert-community'],
  allowed: ['cpu', 'gpu', 'npu'] as const,
  platform: 'win-x64' as const,
  curated: [] as Array<{ repo: string; variants: Array<{ id: string }> }>,
}

beforeEach(() => resetHfLiteRtCache())

// The same file names as `eye-cli` (`src/workspace-service/litert-hf.test.ts`): app and atc must
// offer the same variants of a repository (spec litert-lm-models, design D4).
describe('classifyLiteRtFile', () => {
  it.each([
    ['gemma-4-E2B-it.litertlm', { kind: 'plain', stem: 'gemma-4-E2B-it' }],
    ['gemma-4-E2B-it-gpu.litertlm', { kind: 'variant', stem: 'gemma-4-E2B-it', backend: 'gpu' }],
    ['qwen3_4b_mixed_int4_gpu.litertlm', { kind: 'variant', stem: 'qwen3_4b_mixed_int4', backend: 'gpu' }],
    [
      'gemma-4-E2B-it_intel_LNL.litertlm',
      { kind: 'variant', stem: 'gemma-4-E2B-it', backend: 'npu', npu: 'intel-lnl' },
    ],
    [
      'gemma-4-E2B-it_intel_PTL.litertlm',
      { kind: 'variant', stem: 'gemma-4-E2B-it', backend: 'npu', npu: 'intel-ptl' },
    ],
    ['sub/dir/model.litertlm', { kind: 'plain', stem: 'model' }],
  ])('%s', (path, expected) => expect(classifyLiteRtFile(path)).toEqual(expected))

  it.each([
    'gemma-4-E2B-it-web.litertlm',
    'gemma-4-E2B-it_web.litertlm',
    'gemma-4-E2B-it_Google_Tensor_G5.litertlm',
    'gemma-4-E2B-it_sm8750.litertlm',
    'gemma-4-E2B-it_SM8650.litertlm',
    'gemma-4-E2B-it_mt6993.litertlm',
    'gemma-4-E2B-it_qualcomm_sm8750.litertlm',
    'gemma-4-E2B-it_Qualcomm_QCS8275.litertlm',
    'gemma-4-E2B-it_intel_NVL.litertlm',
    'gemma-4-E2B-it_mt6993_gpu.litertlm',
    'gemma-4-E2B-it_sm8750-gpu.litertlm',
    'gemma-4-E2B-it-web_gpu.litertlm',
    'gemma-4-E2B-it.task',
    'gemma-4-E2B-it-web.task',
    'README.md',
  ])('offers nothing for %s', (path) => expect(classifyLiteRtFile(path)).toBeNull())
})

describe('hfVariants', () => {
  const file = (path: string) => ({ path, size: 100, sha256: 'a'.repeat(64) })

  it('builds cpu, gpu and npu (intel-lnl) from the spec’s repository, no web or Tensor file', () => {
    // spec litert-lm-models "Репозиторий с файлами под чипы".
    const spec = [
      'gemma-4-E2B-it.litertlm',
      'gemma-4-E2B-it-gpu.litertlm',
      'gemma-4-E2B-it-web.litertlm',
      'gemma-4-E2B-it_intel_LNL.litertlm',
      'gemma-4-E2B-it_Google_Tensor_G5.litertlm',
    ].map(file)
    expect(
      hfVariants(spec, ['cpu', 'gpu', 'npu']).map((v) => [v.id, v.backend, v.npu ?? null, v.file.path])
    ).toEqual([
      ['gemma-4-e2b-it-npu-intel-lnl', 'npu', 'intel-lnl', 'gemma-4-E2B-it_intel_LNL.litertlm'],
      ['gemma-4-e2b-it-gpu', 'gpu', null, 'gemma-4-E2B-it-gpu.litertlm'],
      ['gemma-4-e2b-it-cpu', 'cpu', null, 'gemma-4-E2B-it.litertlm'],
    ])
  })

  it('offers the plain file for the GPU too when the repository has no GPU file', () => {
    expect(hfVariants([file('gemma-4-E2B-it.litertlm')], ['cpu', 'gpu']).map((v) => [v.id, v.file.path])).toEqual([
      ['gemma-4-e2b-it-gpu', 'gemma-4-E2B-it.litertlm'],
      ['gemma-4-e2b-it-cpu', 'gemma-4-E2B-it.litertlm'],
    ])
  })

  it('offers only the backends conf allows on this platform', () => {
    // spec "GPU на Windows закрыт данными conf".
    const files = ['gemma-4-E2B-it.litertlm', 'gemma-4-E2B-it-gpu.litertlm', 'gemma-4-E2B-it_intel_LNL.litertlm'].map(file)
    expect(hfVariants(files, ['cpu', 'npu']).map((v) => v.backend)).toEqual(['npu', 'cpu'])
  })

  it('keeps each quantisation of a repository as its own variant', () => {
    const qwen = ['qwen3_4b_mixed_int4.litertlm', 'qwen3_4b_channelwise_int8_float32kv.litertlm'].map(file)
    expect(hfVariants(qwen, ['cpu']).map((v) => v.id)).toEqual([
      'qwen3_4b_mixed_int4-cpu',
      'qwen3_4b_channelwise_int8_float32kv-cpu',
    ])
  })

  it('skips a file without an LFS sha256', () => {
    expect(hfVariants([{ path: 'm.litertlm', size: 10, sha256: null }], ['cpu'])).toEqual([])
  })
})

describe('uniqueHfIds', () => {
  const v = (id: string) => ({ id, backend: 'cpu' as const, file: { path: 'm.litertlm', size: 1, sha256: 'a'.repeat(64) } })

  it('keeps an id nobody else holds, and names a taken one by its repository', () => {
    expect(uniqueHfIds([v('gemma-cpu')], 'litert-community/Gemma-X', new Set())).toEqual([v('gemma-cpu')])
    expect(uniqueHfIds([v('gemma-cpu')], 'litert-community/Gemma-X', new Set(['gemma-cpu'])).map((x) => x.id)).toEqual([
      'gemma-x-gemma-cpu',
    ])
  })
})

describe('fetchHfLiteRtModels', () => {
  it('lists the tagged chat repositories of conf’s organisations and builds their variants at the listed commit', async () => {
    const { fetchJson, asked } = hub({
      [`${HUB}/api/models/litert-community/functiongemma-270m-ft-mobile-actions/revision/main?blobs=true`]: new Error('404'),
      [`${HUB}/api/models/litert-community/embeddinggemma-2-740m-litert-lm/revision/main?blobs=true`]: {
        sha: 'c'.repeat(40),
        gated: false,
        siblings: [],
      },
      [`${HUB}/api/models/litert-community/gemma-4-E4B-it-litert-lm/revision/main?blobs=true`]: new Error('404'),
    })

    const result = await fetchHfLiteRtModels({ ...base, fetchJson })

    expect(asked[0]).toBe(`${HUB}/api/models?author=litert-community&filter=litert-lm&sort=downloads&direction=-1&limit=1000`)
    // Speech models are not chat models: never asked about.
    expect(asked.some((url) => url.includes('Kokoro') || url.includes('parakeet'))).toBe(false)
    expect(result.unavailable).toBe(false)
    const gemma = result.models.find((model) => model.repo === 'litert-community/gemma-4-E2B-it-litert-lm')
    expect(gemma).toMatchObject({
      revision: 'a790a852d433991c0c0a41c1154cf9b3850300fa',
      gated: false,
      license: 'apache-2.0',
      name: 'gemma-4-E2B-it-litert-lm',
    })
    expect(gemma?.variants.map((v) => [v.id, v.backend, v.npu ?? null, v.file.path, v.platforms])).toEqual([
      ['gemma-4-e2b-it-npu-intel-lnl', 'npu', 'intel-lnl', 'gemma-4-E2B-it_intel_LNL.litertlm', ['win-x64']],
      ['gemma-4-e2b-it-npu-intel-ptl', 'npu', 'intel-ptl', 'gemma-4-E2B-it_intel_PTL.litertlm', ['win-x64']],
      ['gemma-4-e2b-it-gpu', 'gpu', null, 'gemma-4-E2B-it-gpu.litertlm', ['win-x64']],
      ['gemma-4-e2b-it-cpu', 'cpu', null, 'gemma-4-E2B-it.litertlm', ['win-x64']],
    ])
    // Size and sha256 are the tree's LFS metadata.
    expect(gemma?.variants.find((v) => v.backend === 'cpu')?.file).toEqual({
      path: 'gemma-4-E2B-it.litertlm',
      size: 2588147712,
      sha256: '181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c',
    })
    const qwen = result.models.find((model) => model.repo === 'litert-community/Qwen3-4B')
    expect(qwen?.variants.map((v) => v.id)).toEqual([
      'qwen3_4b_channelwise_int8_float32kv-gpu',
      'qwen3_4b_mixed_int4-gpu',
      'qwen3_4b_channelwise_int8_float32kv-cpu',
      'qwen3_4b_mixed_int4-cpu',
    ])
    // A repository without a `.litertlm` file has nothing to offer; one the Hub does not answer for is left out.
    expect(result.models.map((model) => model.repo)).toEqual([
      'litert-community/gemma-4-E2B-it-litert-lm',
      'litert-community/Qwen3-4B',
    ])
  })

  it('offers only the backends conf allows for this platform', async () => {
    const { fetchJson } = hub()

    const result = await fetchHfLiteRtModels({ ...base, allowed: ['cpu'], platform: 'macos-arm64', fetchJson })

    const gemma = result.models.find((model) => model.repo === 'litert-community/gemma-4-E2B-it-litert-lm')
    expect(gemma?.variants.map((v) => [v.backend, v.platforms])).toEqual([['cpu', ['macos-arm64']]])
  })

  it('leaves a repository conf’s curated list holds to the curated entry, and keeps its variant ids apart', async () => {
    const { fetchJson, asked } = hub()

    const result = await fetchHfLiteRtModels({
      ...base,
      curated: [
        { repo: 'litert-community/gemma-4-e2b-it-litert-lm', variants: [{ id: 'gemma-4-e2b-cpu' }] },
        { repo: 'litert-community/other', variants: [{ id: 'qwen3_4b_mixed_int4-cpu' }] },
      ],
      fetchJson,
    })

    expect(result.models.map((model) => model.repo)).not.toContain('litert-community/gemma-4-E2B-it-litert-lm')
    expect(asked.some((url) => url.includes('gemma-4-E2B-it-litert-lm/revision'))).toBe(false)
    const qwen = result.models.find((model) => model.repo === 'litert-community/Qwen3-4B')
    expect(qwen?.variants.map((v) => v.id)).toContain('qwen3-4b-qwen3_4b_mixed_int4-cpu')
  })

  it('reads only the repositories a search names', async () => {
    const { fetchJson, asked } = hub()

    const result = await fetchHfLiteRtModels({ ...base, query: 'qwen3', fetchJson })

    expect(result.models.map((model) => model.repo)).toEqual(['litert-community/Qwen3-4B'])
    expect(asked.filter((url) => url.includes('/revision/'))).toEqual([
      `${HUB}/api/models/litert-community/Qwen3-4B/revision/main?blobs=true`,
    ])
  })

  it('asks the Hub once per Hub session for the same repositories', async () => {
    const { fetchJson } = hub()

    const first = await fetchHfLiteRtModels({ ...base, query: 'qwen3', fetchJson })
    const second = await fetchHfLiteRtModels({ ...base, query: 'qwen3', fetchJson })

    expect(second).toEqual(first)
    expect(second.models.map((model) => model.repo)).toEqual(['litert-community/Qwen3-4B'])
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('says Hugging Face is unavailable when the listing fails, and asks again next time', async () => {
    // spec litert-lm-models "Hugging Face недоступен".
    const down = hub({
      [`${HUB}/api/models?author=litert-community&filter=litert-lm&sort=downloads&direction=-1&limit=1000`]:
        new Error('getaddrinfo ENOTFOUND huggingface.co'),
    })

    const result = await fetchHfLiteRtModels({ ...base, fetchJson: down.fetchJson })

    expect(result).toEqual({ models: [], unavailable: true, error: 'getaddrinfo ENOTFOUND huggingface.co' })
    const up = hub()
    await expect(fetchHfLiteRtModels({ ...base, fetchJson: up.fetchJson })).resolves.toMatchObject({ unavailable: false })
  })

  it('marks a gated repository', async () => {
    const { fetchJson } = hub({
      [`${HUB}/api/models/litert-community/Qwen3-4B/revision/main?blobs=true`]: { ...qwenRevision, gated: 'auto' },
    })

    const result = await fetchHfLiteRtModels({ ...base, query: 'qwen3', fetchJson })

    expect(result.models[0].gated).toBe(true)
  })
})
