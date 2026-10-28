import { beforeEach, describe, expect, it, vi } from 'vitest'

import gemmaRevision from './fixtures/hf-revision-gemma-4-E2B-it-qat-q4_0-gguf.json'
import qwenRevision from './fixtures/hf-revision-Qwen3-4B-GGUF.json'
import {
  classifyGgufFile,
  fetchHfGeniexModels,
  geniexHfModelId,
  hfGgufFiles,
  resetHfGeniexCache,
} from '../huggingface'

// Recorded answers of the Hugging Face API (28 October 2026, trimmed): `unsloth/Qwen3-4B-GGUF` and
// `google/gemma-4-E2B-it-qat-q4_0-gguf` at the commit `main` named then.
const HUB = 'https://huggingface.co'
const QWEN = 'unsloth/Qwen3-4B-GGUF'
const GEMMA = 'google/gemma-4-E2B-it-qat-q4_0-gguf'

function hub(overrides: Record<string, unknown> = {}) {
  const asked: string[] = []
  const fetchJson = vi.fn(async (url: string) => {
    asked.push(url)
    if (url in overrides) {
      const answer = overrides[url]
      if (answer instanceof Error) throw answer
      return answer
    }
    if (url === `${HUB}/api/models/${QWEN}/revision/main?blobs=true`) return qwenRevision
    if (url === `${HUB}/api/models/${GEMMA}/revision/main?blobs=true`) return gemmaRevision
    throw new Error(`not recorded: ${url}`)
  })
  return { fetchJson, asked }
}

const base = {
  candidates: [QWEN, GEMMA],
  quantizations: ['Q4_0'],
  allowed: ['npu', 'gpu', 'cpu', 'hybrid'] as const,
  platform: 'win-arm64' as const,
  curated: [] as Array<{ id: string; repo: string }>,
}

beforeEach(() => resetHfGeniexCache())

describe('classifyGgufFile', () => {
  it.each([
    ['Qwen3-4B-Q4_0.gguf', { kind: 'model', quantization: 'Q4_0' }],
    // Google's QAT repositories spell the quantization in lower case, in the middle of the name.
    ['gemma-4-E2B_q4_0-it.gguf', { kind: 'model', quantization: 'Q4_0' }],
    ['gemma-4-E2B-it-mmproj.gguf', { kind: 'mmproj' }],
    ['mmproj-F16.gguf', { kind: 'mmproj' }],
    ['sub/dir/model-Q4_0.gguf', { kind: 'model', quantization: 'Q4_0' }],
  ])('%s', (path, expected) => expect(classifyGgufFile(path, ['Q4_0'])).toEqual(expected))

  it.each([
    // Other quantizations are not offered: the Hexagon backend runs Q4_0 best (spec "Репозиторий с
    // несколькими квантованиями").
    'Qwen3-4B-Q4_K_M.gguf',
    'Qwen3-4B-Q8_0.gguf',
    'Qwen3-4B-UD-Q4_K_XL.gguf',
    'Qwen3-4B-IQ4_NL.gguf',
    // A sharded file is several files: the host loads one.
    'Qwen3-4B-Q4_0-00001-of-00002.gguf',
    'README.md',
    'imatrix_unsloth.dat',
  ])('offers nothing for %s', (path) => expect(classifyGgufFile(path, ['Q4_0'])).toBeNull())

  it('offers the quantizations conf lists, whatever their case in the file name', () => {
    expect(classifyGgufFile('Qwen3-4B-Q4_K_M.gguf', ['Q4_0', 'Q4_K_M'])).toEqual({ kind: 'model', quantization: 'Q4_K_M' })
    expect(classifyGgufFile('qwen3-4b-q4_k_m.gguf', ['Q4_K_M'])).toEqual({ kind: 'model', quantization: 'Q4_K_M' })
  })
})

describe('hfGgufFiles', () => {
  it('picks the Q4_0 file of the Qwen3 repository with its LFS size and sha256, and finds no projector', () => {
    const q4 = qwenRevision.siblings.find((s) => s.rfilename === 'Qwen3-4B-Q4_0.gguf') as { lfs: { sha256: string } }
    expect(q4.lfs.sha256).toMatch(/^92f4a83cdfe6[0-9a-f]{52}$/)
    expect(hfGgufFiles(qwenRevision.siblings, ['Q4_0'])).toEqual({
      quantization: 'Q4_0',
      file: { path: 'Qwen3-4B-Q4_0.gguf', size: 2375773472, sha256: q4.lfs.sha256 },
    })
  })

  it('picks the Gemma 4 QAT file and the projector beside it', () => {
    // spec geniex-models: "а mmproj — если он есть в репозитории".
    const picked = hfGgufFiles(gemmaRevision.siblings, ['Q4_0'])
    expect(picked?.file.path).toBe('gemma-4-E2B_q4_0-it.gguf')
    expect(picked?.mmproj?.path).toBe('gemma-4-E2B-it-mmproj.gguf')
    expect(picked?.mmproj?.size).toBe(986833664)
  })

  it('takes the first quantization in conf’s order that the repository has', () => {
    expect(hfGgufFiles(qwenRevision.siblings, ['Q8_0', 'Q4_0'])?.file.path).toBe('Qwen3-4B-Q8_0.gguf')
    expect(hfGgufFiles(qwenRevision.siblings, ['F16'])).toBeNull()
  })

  it('skips a file without an LFS sha256', () => {
    expect(hfGgufFiles([{ rfilename: 'm-Q4_0.gguf', size: 10 }], ['Q4_0'])).toBeNull()
  })
})

describe('geniexHfModelId', () => {
  it('names the model after its repository, and by its organisation too when the name is taken', () => {
    expect(geniexHfModelId('unsloth/Qwen3-4B-GGUF', new Set())).toBe('qwen3-4b-gguf')
    expect(geniexHfModelId('unsloth/Qwen3-4B-GGUF', new Set(['qwen3-4b-gguf']))).toBe('unsloth-qwen3-4b-gguf')
  })
})

describe('fetchHfGeniexModels', () => {
  it('reads each candidate repository at the commit main names and offers only the Q4_0 file, the projector and conf’s devices', async () => {
    const { fetchJson, asked } = hub()

    const result = await fetchHfGeniexModels({ ...base, fetchJson })

    expect(asked).toEqual([
      `${HUB}/api/models/${QWEN}/revision/main?blobs=true`,
      `${HUB}/api/models/${GEMMA}/revision/main?blobs=true`,
    ])
    expect(result.unavailable).toBe(false)
    expect(result.models.map((m) => [m.model_id, m.repo, m.file.path, m.mmproj?.path ?? null])).toEqual([
      ['qwen3-4b-gguf', QWEN, 'Qwen3-4B-Q4_0.gguf', null],
      ['gemma-4-e2b-it-qat-q4_0-gguf', GEMMA, 'gemma-4-E2B_q4_0-it.gguf', 'gemma-4-E2B-it-mmproj.gguf'],
    ])
    expect(result.models[0]).toMatchObject({
      revision: '22c9fc8a8c7700b76a1789366280a6a5a1ad1120',
      gated: false,
      license: 'apache-2.0',
      name: 'Qwen3-4B-GGUF',
      devices: ['npu', 'gpu', 'cpu', 'hybrid'],
      platforms: ['win-arm64'],
    })
  })

  it('leaves a repository conf’s curated list holds to the curated entry, and never reuses its id', async () => {
    // spec geniex-models: "Если модель с тем же репозиторием есть в курированном списке, MUST
    // использоваться запись курированного списка".
    const { fetchJson, asked } = hub()

    const result = await fetchHfGeniexModels({
      ...base,
      curated: [{ id: 'qwen3-4b', repo: 'unsloth/qwen3-4b-gguf' }, { id: 'gemma-4-e2b-it-qat-q4_0-gguf', repo: 'other/x' }],
      fetchJson,
    })

    expect(asked).toEqual([`${HUB}/api/models/${GEMMA}/revision/main?blobs=true`])
    expect(result.models.map((m) => m.model_id)).toEqual(['google-gemma-4-e2b-it-qat-q4_0-gguf'])
  })

  it('offers only the devices conf allows for this platform, and no model when it allows none', async () => {
    // spec geniex-models "NPU для HF закрыт данными conf".
    const narrowed = await fetchHfGeniexModels({ ...base, allowed: ['gpu', 'cpu'], fetchJson: hub().fetchJson })
    expect(narrowed.models.map((m) => m.devices)).toEqual([['gpu', 'cpu'], ['gpu', 'cpu']])

    const none = await fetchHfGeniexModels({ ...base, allowed: [], fetchJson: hub().fetchJson })
    expect(none.models).toEqual([])
    expect(none.unavailable).toBe(false)
  })

  it('says Hugging Face is unavailable when no repository could be read, and leaves out one it could not', async () => {
    // spec geniex-models: "Если Hugging Face недоступен, клиент SHALL показывать только курированный
    // список с сообщением о недоступности".
    const down = hub({
      [`${HUB}/api/models/${QWEN}/revision/main?blobs=true`]: new Error('Hugging Face answered 503'),
      [`${HUB}/api/models/${GEMMA}/revision/main?blobs=true`]: new Error('Hugging Face answered 503'),
    })
    const result = await fetchHfGeniexModels({ ...base, fetchJson: down.fetchJson })
    expect(result).toMatchObject({ models: [], unavailable: true })

    resetHfGeniexCache()
    const partial = hub({ [`${HUB}/api/models/${QWEN}/revision/main?blobs=true`]: new Error('404') })
    const some = await fetchHfGeniexModels({ ...base, fetchJson: partial.fetchJson })
    expect(some.unavailable).toBe(false)
    expect(some.models.map((m) => m.repo)).toEqual([GEMMA])
  })

  it('reads a repository once per Hub session, and answers the same models again', async () => {
    const { fetchJson, asked } = hub()
    const first = await fetchHfGeniexModels({ ...base, fetchJson })
    const second = await fetchHfGeniexModels({ ...base, fetchJson })
    expect(asked).toHaveLength(2)
    expect(second.models).toEqual(first.models)
    expect(second.models.map((m) => m.repo)).toEqual([QWEN, GEMMA])
  })
})
