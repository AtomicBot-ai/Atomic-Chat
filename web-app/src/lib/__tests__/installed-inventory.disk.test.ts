import { describe, expect, it } from 'vitest'

import type { PartialDownload } from '@/lib/downloads-disk'
import {
  activeDownloadIds,
  downloadItems,
  draftItems,
  inventoryTotalBytes,
  isDownloadActive,
  mlxDraftersOn,
  partialDownloadItems,
  providerModelItems,
  withMeasuredSizes,
} from '@/lib/installed-inventory'

const GB = 1024 ** 3

const provider = (
  name: string,
  models: Partial<Model>[],
  settings: ProviderSetting[] = []
): ModelProvider =>
  ({
    active: true,
    provider: name,
    persist: true,
    settings,
    models: models.map((model) => ({ id: 'unset', ...model })),
  }) as ModelProvider

const partial = (
  id: string,
  patch: Partial<PartialDownload> = {}
): PartialDownload => ({
  root: 'llamacpp/models',
  id,
  paths: [`/data/llamacpp/models/${id}`],
  bytes: 3 * GB,
  ...patch,
})

describe('model rows', () => {
  it('read an id as a name, keep a nickname or an engine’s name as given, and keep the quant apart', () => {
    const items = providerModelItems([
      provider('llamacpp-upstream', [
        { id: 'unsloth/Qwen3.5-4B-Q4_K_M' },
        { id: 'unsloth/Qwen3.5-4B-Q8_0' },
        {
          id: 'bartowski/gemma-3-1b-it-IQ4_XS',
          displayName: 'My Gemma IQ4_XS',
        },
      ]),
      provider('foundry-local', [{ id: 'phi-4-mini-cpu', name: 'Phi-4 mini' }]),
    ])

    expect(items.map((item) => item.owner)).toEqual([
      'unsloth',
      'unsloth',
      'bartowski',
      undefined,
    ])
    expect(
      items.map(({ name, quant, modelId }) => ({ name, quant, modelId }))
    ).toEqual([
      // Two quants of one model: one name, told apart by the quant.
      {
        name: 'Qwen3.5 4B',
        quant: 'Q4_K_M',
        modelId: 'unsloth/Qwen3.5-4B-Q4_K_M',
      },
      { name: 'Qwen3.5 4B', quant: 'Q8_0', modelId: 'unsloth/Qwen3.5-4B-Q8_0' },
      // A nickname that spells its quant is not followed by it again.
      {
        name: 'My Gemma IQ4_XS',
        quant: undefined,
        modelId: 'bartowski/gemma-3-1b-it-IQ4_XS',
      },
      { name: 'Phi-4 mini', quant: undefined, modelId: 'phi-4-mini-cpu' },
    ])
  })
})

describe('running model downloads', () => {
  it('reads the owner past a task id’s provider prefix and drafter tag', () => {
    const id = 'mlx/dflash:z-lab/Qwen3_5-4B-DFlash'
    const [item] = downloadItems({
      downloads: {},
      localDownloadingModels: new Set([id]),
      pausedDownloads: new Set(),
      downloadOriginByModelId: {},
      diffusionCatalog: null,
      embeddingModels: [],
      decisionModels: [],
    })

    expect(item).toMatchObject({
      name: 'Qwen3.5 4B DFlash',
      owner: 'z-lab',
      modelId: id,
    })
  })
})

describe('withMeasuredSizes', () => {
  it("fills in an MLX model's size from its folder, and only where none was recorded", () => {
    const items = providerModelItems([
      provider('mlx', [
        { id: 'gemma-4-e4b-it-4bit', sizeBytes: 0 },
        { id: 'Qwen3.5-4B-4bit', sizeBytes: 2 * GB },
      ]),
      provider('llamacpp-upstream', [{ id: 'unsloth/Qwen3.5-4B-Q4_K_M' }]),
    ])

    const measured = withMeasuredSizes(items, {
      'gemma-4-e4b-it-4bit': 4.9 * GB,
      'Qwen3.5-4B-4bit': 1,
      // An id the llama.cpp row shares is not MLX's to size.
      'unsloth/Qwen3.5-4B-Q4_K_M': 7 * GB,
    })

    expect(measured.map((item) => [item.modelId, item.bytes])).toEqual([
      ['unsloth/Qwen3.5-4B-Q4_K_M', null],
      ['gemma-4-e4b-it-4bit', 4.9 * GB],
      ['Qwen3.5-4B-4bit', 2 * GB],
    ])
    expect(inventoryTotalBytes(measured)).toBe(6.9 * GB)
  })
})

describe('partial downloads', () => {
  const store = (patch: Partial<Parameters<typeof activeDownloadIds>[0]>) =>
    activeDownloadIds({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      ...patch,
    })

  it('shows cancelled leftovers even when retry metadata remains resumable', () => {
    const id = 'org/cancelled'
    const active = store({
      resumableDownloads: new Set([id]),
      dismissedDownloads: new Set([id]),
    })
    expect(active).not.toContain(id)
    expect(partialDownloadItems([partial(id)], active)).toHaveLength(1)
    expect(
      partialDownloadItems(
        [partial(id)],
        store({ pausedDownloads: new Set([id]) })
      )
    ).toHaveLength(0)
  })

  it('leaves out the partial files of a download the app is running, paused or can resume', () => {
    const partials = [
      partial('AtomicChat/qwen35-4b-IQ4_XS'),
      partial('Meta-Llama-3_1-8B-Instruct-IQ4_XS'),
      partial('unsloth/gemma-3-1b-it-IQ4_XS'),
      partial('z-lab/Qwen3.5-4B-DFlash', { root: 'mlx/draft-models' }),
      partial('gemma-4-e2b-it-4bit', { root: 'mlx/models' }),
    ]
    const active = store({
      // Keyed by the model id the Hub downloads under, dots and all.
      downloads: {
        'Meta-Llama-3.1-8B-Instruct-IQ4_XS': {
          id: 'Meta-Llama-3.1-8B-Instruct-IQ4_XS',
          name: 'Meta-Llama-3.1-8B-Instruct-IQ4_XS',
        },
      },
      pausedDownloads: new Set(['unsloth/gemma-3-1b-it-IQ4_XS']),
      // A drafter download carries its family tag before the repo.
      localDownloadingModels: new Set(['mlx/dflash:z-lab/Qwen3_5-4B-DFlash']),
    })

    const items = partialDownloadItems(partials, active)

    expect(items.map((item) => item.modelId)).toEqual([
      'AtomicChat/qwen35-4b-IQ4_XS',
      'gemma-4-e2b-it-4bit',
    ])
    expect(items[0]).toMatchObject({
      key: 'partial:llamacpp/models:AtomicChat/qwen35-4b-IQ4_XS',
      category: 'local',
      kind: 'partial',
      name: 'Qwen3.5 4B',
      quant: 'IQ4_XS',
      details: ['llama.cpp'],
      bytes: 3 * GB,
      removal: {
        type: 'partial',
        paths: ['/data/llamacpp/models/AtomicChat/qwen35-4b-IQ4_XS'],
        downloadId: 'AtomicChat/qwen35-4b-IQ4_XS',
      },
    })
    expect(items[1].details).toEqual(['MLX'])
  })

  it.each(['running', 'paused'])(
    'does not duplicate the reported long model id while %s',
    (phase) => {
      const id =
        'AtomicChat/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64'
      const active = store(
        phase === 'running'
          ? { localDownloadingModels: new Set([id]) }
          : phase === 'paused'
            ? { pausedDownloads: new Set([id]) }
            : {}
      )
      const scanned = [partial(id)]
      expect(partialDownloadItems(scanned, active)).toEqual([])
    }
  )

  it('names an unfinished download by its model, with the quant apart and the id kept', () => {
    const [item] = partialDownloadItems(
      [partial('AtomicChat/NVIDIA-Nemotron-3_5-Lightning-30B-A3B-Q4_K_M')],
      []
    )

    // Cut short at the end, the id lost its quant first; two quants of one
    // model read the same.
    expect(item).toMatchObject({
      name: 'NVIDIA Nemotron 3.5 Lightning 30B A3B',
      quant: 'Q4_K_M',
      modelId: 'AtomicChat/NVIDIA-Nemotron-3_5-Lightning-30B-A3B-Q4_K_M',
      details: ['llama.cpp'],
    })
    // A quant spelled mid-name is not the file's: the last one is.
    expect(
      partialDownloadItems(
        [
          partial(
            'mradermacher/gemma-4-31B-it-qat-q4_0-unquantized-heretic_i1-Q3_K_S'
          ),
        ],
        []
      )[0].quant
    ).toBe('Q3_K_S')
  })

  it("reads a provider-prefixed task id or a draft's download as its folder's", () => {
    expect(
      isDownloadActive('gemma-4-e2b-it-4bit', ['mlx/gemma-4-e2b-it-4bit'])
    ).toBe(true)
    expect(
      isDownloadActive('unsloth/Qwen3.5-9B', [
        'llamacpp-upstream/unsloth/Qwen3_5-9B-mtp-draft',
      ])
    ).toBe(true)
    expect(isDownloadActive('unsloth/Qwen3.5-9B', ['bartowski/other'])).toBe(
      false
    )
    expect(isDownloadActive('unsloth/Qwen3.5-9B', [])).toBe(false)
  })
})

describe('MLX drafts', () => {
  const draft = {
    id: 'z-lab/Qwen3.5-4B-DFlash',
    path: '/data/mlx/draft-models/z-lab/Qwen3.5-4B-DFlash',
    bytes: GB,
  }
  const toggle = (key: string, value: boolean): ProviderSetting =>
    ({
      key,
      title: key,
      description: '',
      controller_type: 'checkbox',
      controller_props: { value },
    }) as ProviderSetting

  it('is removable only while no MLX drafter switch is on', () => {
    expect(draftItems([draft], false)[0]).toEqual({
      key: `draft:${draft.path}`,
      category: 'local',
      kind: 'draft',
      name: 'z-lab/Qwen3.5-4B-DFlash',
      details: ['MLX'],
      bytes: GB,
      removal: { type: 'draft', path: draft.path },
    })
    expect(draftItems([draft], true)[0].removalBlocked).toBe('draftInUse')
  })

  it('reads the drafter switches off the MLX provider', () => {
    const mlx = (settings: ProviderSetting[]) => [provider('mlx', [], settings)]

    expect(mlxDraftersOn([])).toBe(false)
    expect(
      mlxDraftersOn(
        mlx([toggle('dflash_enabled', false), toggle('mtp_enabled', false)])
      )
    ).toBe(false)
    expect(mlxDraftersOn(mlx([toggle('mtp_enabled', true)]))).toBe(true)
    expect(mlxDraftersOn(mlx([toggle('eagle3_enabled', true)]))).toBe(true)
  })
})
