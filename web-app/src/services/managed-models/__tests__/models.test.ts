import { describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
const { engines } = vi.hoisted(() => ({ engines: new Map<string, unknown>() }))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ getEngine: (id: string) => engines.get(id) }) },
}))

import {
  GatedModelError,
  IncompatibleModelError,
  InsufficientModelSpaceError,
  fetchHfRevision,
  foldTensorName,
  installManagedModel,
  managedModelLocation,
  checkManagedModel,
  readWeightNames,
  managedDownloadId,
  type InstallDeps,
} from '../models'

/** The root of the shared store the core names on Linux (change add-vllm-runtime). */
const LINUX_ROOT = '/home/ann/.local/share/Atomic Chat/data/managed-models'

const SHA = 'c0ffee' + '0'.repeat(34)

/** The one id of this repository's download: task, files, panel row and events (design D6). */
const DOWNLOAD_ID = 'managed-nvidia_Qwen3-8B-FP8'

/** A Hugging Face that answers the API listing and the files of one repository. */
function hub(options: { status?: number; quant?: boolean } = {}) {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('Authorization')
    calls.push({ url, auth })
    if (options.status) return new Response('{"error":"gated"}', { status: options.status })
    if (url.startsWith('https://huggingface.co/api/models/nvidia/Qwen3-8B-FP8/revision/main')) {
      return Response.json({
        sha: SHA,
        siblings: [
          { rfilename: 'config.json', size: 700 },
          ...(options.quant ? [{ rfilename: 'hf_quant_config.json', size: 200 }] : []),
          {
            rfilename: 'model-00001-of-00002.safetensors',
            size: 134,
            lfs: { sha256: 'a'.repeat(64), size: 5_000_000_000 },
          },
          {
            rfilename: 'model-00002-of-00002.safetensors',
            size: 134,
            lfs: { sha256: 'b'.repeat(64), size: 3_000_000_000 },
          },
          { rfilename: 'tokenizer.json', size: 11_000 },
        ],
      })
    }
    if (url === `https://huggingface.co/nvidia/Qwen3-8B-FP8/resolve/${SHA}/config.json`) {
      return Response.json({ architectures: ['Qwen3ForCausalLM'] })
    }
    if (url === `https://huggingface.co/nvidia/Qwen3-8B-FP8/resolve/${SHA}/hf_quant_config.json`) {
      return Response.json({ quantization: { quant_algo: 'FP8' } })
    }
    return new Response('not found', { status: 404 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const verdict = (ok: boolean) => ({
  architectures: ['Qwen3ForCausalLM'],
  quantization_format: 'fp8',
  weight_bytes: 8_000_000_000,
  checked_gpu_id: 'GPU-1',
  curated: false,
  unified_memory: false,
  fits_other_gpus: ok ? [] : ['GPU-2'],
  verdict: ok
    ? { ok: true as const }
    : {
        ok: false as const,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'Needs 12.4 GB free, the card has 7.8 GB.',
        },
      },
})

function deps(overrides: Partial<InstallDeps> = {}) {
  const steps: string[] = []
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
  const d: InstallDeps = {
    emit: (event, payload) => {
      emitted.push({ event, payload: payload as Record<string, unknown> })
    },
    fetch: hub().fetch,
    check: vi.fn(async () => verdict(true)),
    location: vi.fn(async () => ({ root: LINUX_ROOT, free_bytes: 500_000_000_000 })),
    existingSize: vi.fn(async () => null),
    hasPartial: vi.fn(async () => false),
    transfer: vi.fn(async (items) => {
      steps.push(`transfer:${items.map((i) => i.save_path.split('/').pop()).join(',')}`)
    }),
    writeYaml: vi.fn(async (savePath) => {
      steps.push(`yaml:${savePath}`)
    }),
    ...overrides,
  }
  return { d, steps, emitted }
}

describe('fetchHfRevision', () => {
  it('pins the revision to its commit and lists every file with its size and LFS sha256', async () => {
    const { fetch, calls } = hub({ quant: true })

    const meta = await fetchHfRevision('nvidia/Qwen3-8B-FP8', undefined, 'hf_secret', fetch)

    expect(meta.revision).toBe(SHA)
    expect(meta.config_json).toEqual({ architectures: ['Qwen3ForCausalLM'] })
    expect(meta.hf_quant_config_json).toEqual({ quantization: { quant_algo: 'FP8' } })
    expect(meta.files).toContainEqual({
      path: 'model-00001-of-00002.safetensors',
      size: 5_000_000_000,
      sha256: 'a'.repeat(64),
    })
    expect(meta.files).toContainEqual({ path: 'tokenizer.json', size: 11_000, sha256: null })
    // Files are read at the pinned commit, never at a moving branch.
    expect(calls.some((c) => c.url.includes(`/resolve/${SHA}/`))).toBe(true)
    expect(calls.every((c) => c.auth === 'Bearer hf_secret')).toBe(true)
  })

  it('reads no quantization file a repository does not have', async () => {
    const meta = await fetchHfRevision('nvidia/Qwen3-8B-FP8', undefined, undefined, hub().fetch)

    expect(meta.hf_quant_config_json).toBeNull()
  })

  it('turns a refused listing into "accept the terms on the model page", with the link', async () => {
    // spec "Gated-модель без принятых условий".
    for (const status of [401, 403]) {
      const error = await fetchHfRevision('meta-llama/Llama-3.3-70B-Instruct', undefined, undefined, hub({ status }).fetch).catch(
        (e: unknown) => e
      )

      expect(error).toBeInstanceOf(GatedModelError)
      expect((error as GatedModelError).url).toBe('https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct')
    }
  })
})

describe('installManagedModel', () => {
  it('downloads nothing for a model the core finds incompatible, and says why with the other card', async () => {
    // spec "Вставлен несовместимый репозиторий".
    const { d, steps } = deps({ check: vi.fn(async () => verdict(false)) })

    const error = await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IncompatibleModelError)
    expect((error as IncompatibleModelError).message).toContain('12.4 GB')
    expect((error as IncompatibleModelError).fitsOtherGpus).toEqual(['GPU-2'])
    expect(steps).toEqual([])
  })

  it('asks the core with the metadata of the pinned revision, then downloads every file into the model folder', async () => {
    const { d } = deps()

    const installed = await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

    expect(installed.modelId).toBe('nvidia/Qwen3-8B-FP8')
    expect(d.check).toHaveBeenCalledWith(
      'tensorrt-llm',
      expect.objectContaining({ repository: 'nvidia/Qwen3-8B-FP8', revision: SHA })
    )
    const items = vi.mocked(d.transfer).mock.calls[0][0]
    // Under the root of the shared store the core names; on Linux `<data>/managed-models`.
    expect(items.map((i) => i.save_path)).toEqual([
      `${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/config.json`,
      `${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model-00001-of-00002.safetensors`,
      `${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model-00002-of-00002.safetensors`,
      `${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/tokenizer.json`,
    ])
    expect(items[1]).toMatchObject({
      url: `https://huggingface.co/nvidia/Qwen3-8B-FP8/resolve/${SHA}/model-00001-of-00002.safetensors`,
      sha256: 'a'.repeat(64),
      size: 5_000_000_000,
    })
  })

  it('writes model.yml last, and only once every file is on disk', async () => {
    // spec "Модель докачана в app": a folder without model.yml is not a model.
    const { d, steps } = deps()

    await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

    expect(steps.at(-1)).toBe(`yaml:${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model.yml`)
    const yml = vi.mocked(d.writeYaml).mock.calls[0][1] as Record<string, unknown>
    expect(yml).toMatchObject({
      repository: 'nvidia/Qwen3-8B-FP8',
      revision: SHA,
      architectures: ['Qwen3ForCausalLM'],
    })
    // spec `managed-model-store` "model.yml не зависит от движка": each engine names the format itself.
    expect(yml).not.toHaveProperty('quantization')
  })

  it('writes no model.yml when the download fails', async () => {
    const { d, steps } = deps({
      transfer: vi.fn(async () => {
        throw new Error('connection reset')
      }),
    })

    await expect(installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)).rejects.toThrow(
      'connection reset'
    )
    expect(steps).toEqual([])
  })

  describe('the download panel and its toasts (task 3.18, F-10; design D6)', () => {
    it('names the download once for the task, every file, its progress and its end', async () => {
      const { d, emitted } = deps({
        transfer: vi.fn(async (_items, _taskId, options) => {
          options.onProgress?.(2_000_000_000, 8_000_011_700)
        }),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      expect(managedDownloadId('nvidia/Qwen3-8B-FP8')).toBe(DOWNLOAD_ID)
      const [items, taskId] = vi.mocked(d.transfer).mock.calls[0]
      expect(taskId).toBe(DOWNLOAD_ID)
      expect(new Set(items.map((item) => item.model_id))).toEqual(new Set([DOWNLOAD_ID]))
      expect(emitted.map((e) => [e.event, e.payload.modelId])).toEqual([
        ['onFileDownloadUpdate', DOWNLOAD_ID],
        ['onFileDownloadSuccess', DOWNLOAD_ID],
      ])
      expect(emitted[0].payload).toMatchObject({
        percent: 2_000_000_000 / 8_000_011_700,
        size: { transferred: 2_000_000_000, total: 8_000_011_700 },
        downloadType: 'Model',
      })
    })

    it('passes on no status-only event as progress, so the panel bar never rewinds', async () => {
      // With a Hugging Face token the transfer listens to the downloader itself, which also sends
      // `{ stage }` events without byte counts while it retries (#290).
      const { d, emitted } = deps({
        transfer: vi.fn(async (_items, _taskId, options) => {
          options.onProgress?.(2_000_000_000, 8_000_011_700)
          options.onProgress?.(undefined as unknown as number, undefined as unknown as number)
        }),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8', token: 'hf_secret' }, d)

      const updates = emitted.filter((e) => e.event === 'onFileDownloadUpdate')
      expect(updates.map((e) => e.payload.size)).toEqual([
        { transferred: 2_000_000_000, total: 8_000_011_700 },
      ])
    })

    it('ends a verified download for the id the downloader validated, after model.yml', async () => {
      const { d, steps, emitted } = deps({
        writeYaml: vi.fn(async (savePath: string) => {
          steps.push(`yaml:${savePath}`)
          // Nothing is announced before the model exists.
          expect(emitted).toEqual([])
        }),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      const itemIds = vi.mocked(d.transfer).mock.calls[0][0].map((item) => item.model_id)
      expect(new Set(itemIds)).toEqual(new Set([DOWNLOAD_ID]))
      expect(emitted).toEqual([
        {
          event: 'onFileDownloadSuccess',
          payload: {
            modelId: DOWNLOAD_ID,
            downloadType: 'Model',
            size: { transferred: 8_000_011_700, total: 8_000_011_700 },
          },
        },
      ])
    })

    it('ends a file that failed its sha256 check as a failed validation', async () => {
      const { d, emitted } = deps({
        transfer: vi.fn(async () => {
          throw new Error('Hash verification failed for model-00001-of-00002.safetensors')
        }),
      })

      await expect(installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)).rejects.toThrow(
        'Hash verification failed'
      )
      expect(emitted).toEqual([
        {
          event: 'onModelValidationFailed',
          payload: {
            modelId: DOWNLOAD_ID,
            downloadType: 'Model',
            error: 'Hash verification failed for model-00001-of-00002.safetensors',
            reason: 'validation_failed',
          },
        },
      ])
    })

    it('ends any other failure as a download error', async () => {
      const { d, emitted } = deps({
        transfer: vi.fn(async () => {
          throw new Error('connection reset')
        }),
      })

      await expect(installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)).rejects.toThrow()
      expect(emitted.map((e) => e.event)).toEqual(['onFileDownloadError'])
      expect(emitted[0].payload).toMatchObject({ modelId: DOWNLOAD_ID, error: 'connection reset' })
    })

    it('ends a cancelled download as stopped, not failed, and writes no model.yml', async () => {
      // spec "Отмена в панели загрузок".
      const { d, steps, emitted } = deps({
        transfer: vi.fn(async () => {
          throw new Error('Download cancelled')
        }),
      })

      await expect(installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)).rejects.toThrow(
        'cancelled'
      )
      expect(emitted).toEqual([
        { event: 'onFileDownloadStopped', payload: { modelId: DOWNLOAD_ID, downloadType: 'Model' } },
      ])
      expect(d.writeYaml).not.toHaveBeenCalled()
      expect(steps).toEqual([])
    })

    it('announces nothing when every file was already on disk and nothing was fetched', async () => {
      const sizes: Record<string, number> = {
        'config.json': 700,
        'model-00001-of-00002.safetensors': 5_000_000_000,
        'model-00002-of-00002.safetensors': 3_000_000_000,
        'tokenizer.json': 11_000,
      }
      const { d, emitted } = deps({
        existingSize: vi.fn(async (path: string) => sizes[path.split('/').pop() ?? ''] ?? null),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      expect(d.transfer).not.toHaveBeenCalled()
      expect(emitted).toEqual([])
    })
  })

  it('after a cancel, Download again continues from what is on disk and then writes model.yml', async () => {
    // spec "Отмена в панели загрузок", "Прерванное скачивание": the downloader kept the partials.
    const cancelled = deps({
      transfer: vi.fn(async () => {
        throw new Error('Download cancelled')
      }),
    })
    await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, cancelled.d).catch(() => undefined)

    const again = deps({
      existingSize: vi.fn(async (path: string) =>
        path.endsWith('model-00001-of-00002.safetensors') ? 5_000_000_000 : null
      ),
      hasPartial: vi.fn(async (path: string) => path.endsWith('model-00002-of-00002.safetensors')),
    })
    await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, again.d)

    const [items, taskId, options] = vi.mocked(again.d.transfer).mock.calls[0]
    expect(taskId).toBe(DOWNLOAD_ID)
    expect(items.map((i) => i.save_path.split('/').pop())).not.toContain('model-00001-of-00002.safetensors')
    expect(options).toMatchObject({ resume: true })
    expect(again.steps.at(-1)).toBe(`yaml:${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model.yml`)
  })

  it('does not download again the files already complete on disk, and resumes the rest', async () => {
    // spec "Прерванное скачивание".
    const { d } = deps({
      existingSize: vi.fn(async (path: string) =>
        path.endsWith('model-00001-of-00002.safetensors') ? 5_000_000_000 : null
      ),
    })

    await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

    const [items, , options] = vi.mocked(d.transfer).mock.calls[0]
    expect(items.map((i) => i.save_path.split('/').pop())).not.toContain(
      'model-00001-of-00002.safetensors'
    )
    expect(options).toMatchObject({ resume: true })
  })

  describe('the root and the space the core names (change add-tensorrt-llm-windows)', () => {
    const UNC_ROOT = '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\models\\tensorrt-llm'

    it('on Windows downloads into the distribution, not into the data folder', async () => {
      // spec "Скачивание в дистрибутив на Windows".
      const { d, steps } = deps({ location: vi.fn(async () => ({ root: UNC_ROOT, free_bytes: 300_000_000_000 })) })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      const items = vi.mocked(d.transfer).mock.calls[0][0]
      expect(items[1].save_path).toBe(`${UNC_ROOT}\\nvidia\\Qwen3-8B-FP8\\model-00001-of-00002.safetensors`)
      expect(vi.mocked(d.existingSize).mock.calls[0][0]).toBe(`${UNC_ROOT}\\nvidia\\Qwen3-8B-FP8\\config.json`)
      expect(steps.at(-1)).toBe(`yaml:${UNC_ROOT}\\nvidia\\Qwen3-8B-FP8\\model.yml`)
    })

    it('asks for the location only once the core found the model compatible', async () => {
      const { d } = deps({ check: vi.fn(async () => verdict(false)) })

      const error = await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(IncompatibleModelError)
      expect(d.location).not.toHaveBeenCalled()
    })

    it('compares the free space with the weights still to download and downloads nothing without room', async () => {
      // spec "Скачивание на Windows": the core's free space, not the data folder's volume.
      const { d, steps } = deps({ location: vi.fn(async () => ({ root: UNC_ROOT, free_bytes: 6_000_000_000 })) })

      const error = await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(InsufficientModelSpaceError)
      expect(error).toMatchObject({ root: UNC_ROOT, freeBytes: 6_000_000_000, neededBytes: 8_000_011_700 })
      expect(steps).toEqual([])
    })

    it('counts only what is not on disk yet against the free space', async () => {
      const { d, steps } = deps({
        location: vi.fn(async () => ({ root: LINUX_ROOT, free_bytes: 4_000_000_000 })),
        existingSize: vi.fn(async (path: string) =>
          path.endsWith('model-00001-of-00002.safetensors') ? 5_000_000_000 : null
        ),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      expect(steps).toEqual([
        'transfer:config.json,model-00002-of-00002.safetensors,tokenizer.json',
        `yaml:${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model.yml`,
      ])
    })

    it('leaves a resumed download to the downloader, which counts the bytes already on disk', async () => {
      // Review finding: a half-downloaded shard needs only its rest; the app cannot tell how much.
      const { d, steps } = deps({
        location: vi.fn(async () => ({ root: LINUX_ROOT, free_bytes: 6_000_000_000 })),
        hasPartial: vi.fn(async (path: string) => path.endsWith('model-00001-of-00002.safetensors')),
      })

      await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      expect(steps.at(-1)).toBe(`yaml:${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model.yml`)
    })

    it('lets the downloader decide when the core could not measure the space', async () => {
      const { d, steps } = deps({ location: vi.fn(async () => ({ root: LINUX_ROOT, free_bytes: null })) })

      const installed = await installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)

      expect(installed.modelId).toBe('nvidia/Qwen3-8B-FP8')
      expect(steps.at(-1)).toBe(`yaml:${LINUX_ROOT}/nvidia/Qwen3-8B-FP8/model.yml`)
    })

    it('downloads nothing before Atomic Chat’s distribution exists', async () => {
      // spec "Окружение ещё не установлено": the core answers MANAGED_ADAPTER_UNAVAILABLE.
      const unavailable = Object.assign(new Error('The managed environment is not set up yet.'), {
        code: 'MANAGED_ADAPTER_UNAVAILABLE',
      })
      const { d, steps } = deps({ location: vi.fn(async () => Promise.reject(unavailable)) })

      await expect(installManagedModel({ engineId: 'tensorrt-llm', repository: 'nvidia/Qwen3-8B-FP8' }, d)).rejects.toBe(unavailable)
      expect(steps).toEqual([])
    })
  })
})

/** A real `.safetensors` header: 8-byte little-endian length, then the JSON naming every tensor. */
function safetensorsHeader(names: string[]): Uint8Array {
  const header: Record<string, unknown> = { __metadata__: { format: 'pt' } }
  names.forEach((name, index) => {
    header[name] = { dtype: 'BF16', shape: [1], data_offsets: [index * 2, index * 2 + 2] }
  })
  const json = new TextEncoder().encode(JSON.stringify(header))
  const bytes = new Uint8Array(8 + json.length)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(json.length), true)
  bytes.set(json, 8)
  return bytes
}

/** A Hugging Face that answers range requests on safetensors files from in-memory headers. */
function rangeHub(headersByFile: Record<string, Uint8Array>, options: { ignoreRange?: boolean } = {}) {
  const ranges: string[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    // jsdom's Headers drops Range; the webview's fetch sends it (a CORS-safelisted single range).
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null
    const file = Object.keys(headersByFile).find((name) => url.endsWith(`/${name}`))
    if (!file || !range) return new Response('not found', { status: 404 })
    ranges.push(`${file} ${range}`)
    const bytes = headersByFile[file]
    if (options.ignoreRange) return new Response(bytes, { status: 200 })
    const [from, to] = range.replace('bytes=', '').split('-').map(Number)
    return new Response(bytes.slice(from, to + 1), { status: 206 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, ranges }
}

const shard = (path: string) => ({ path, size: 5_000_000_000, sha256: 'a'.repeat(64) })
const resolve = (path: string) => `https://huggingface.co/acme/m/resolve/${SHA}/${path}`

describe('readWeightNames', () => {
  it("reads every shard's own header by range request, folds layer numbers and de-duplicates", async () => {
    const { fetch, ranges } = rangeHub({
      'model-00001-of-00002.safetensors': safetensorsHeader(['model.layers.0.mlp.gate.weight', 'model.embed_tokens.weight']),
      'model-00002-of-00002.safetensors': safetensorsHeader([
        'model.layers.1.mlp.gate.weight',
        'model.layers.1.mlp.gate.e_score_correction_bias',
      ]),
    })
    const names = await readWeightNames(
      [shard('model-00001-of-00002.safetensors'), shard('model-00002-of-00002.safetensors'), { path: 'config.json', size: 1, sha256: null }],
      resolve,
      undefined,
      fetch
    )
    expect(names).toEqual([
      'model.embed_tokens.weight',
      'model.layers.*.mlp.gate.e_score_correction_bias',
      'model.layers.*.mlp.gate.weight',
    ])
    // One request per shard: the header fits the first probe.
    expect(ranges).toHaveLength(2)
  })

  it('asks for the rest of a header that is longer than the first probe', async () => {
    const long = Array.from({ length: 4_000 }, (_, i) => `model.extra_${i}.weight`)
    const { fetch, ranges } = rangeHub({ 'model.safetensors': safetensorsHeader(long) })
    const names = await readWeightNames([shard('model.safetensors')], resolve, undefined, fetch)
    expect(names).toHaveLength(4_000)
    expect(ranges).toHaveLength(2)
  })

  it('gives up, never downloads the file, when the server ignores Range (no 206)', async () => {
    const { fetch } = rangeHub({ 'model.safetensors': safetensorsHeader(['a.weight']) }, { ignoreRange: true })
    expect(await readWeightNames([shard('model.safetensors')], resolve, undefined, fetch)).toBeUndefined()
  })

  it('is undefined, not an error, for a file that is not safetensors', async () => {
    const { fetch } = rangeHub({ 'model.safetensors': new TextEncoder().encode('not a safetensors file at all') })
    expect(await readWeightNames([shard('model.safetensors')], resolve, undefined, fetch)).toBeUndefined()
  })

  it('ignores consolidated weights next to standard shards, as the core counts weights', async () => {
    const { fetch, ranges } = rangeHub({
      'model.safetensors': safetensorsHeader(['a.weight']),
      'consolidated.safetensors': safetensorsHeader(['b.weight']),
    })
    await readWeightNames([shard('model.safetensors'), shard('consolidated.safetensors')], resolve, undefined, fetch)
    expect(ranges.every((range) => range.startsWith('model.safetensors'))).toBe(true)
  })
})

describe('foldTensorName', () => {
  it('folds numeric path segments only', () => {
    expect(foldTensorName('model.layers.12.mlp.experts.7.w1.weight')).toBe('model.layers.*.mlp.experts.*.w1.weight')
    expect(foldTensorName('model.layers.3.self_attn.q_proj2.weight')).toBe('model.layers.*.self_attn.q_proj2.weight')
  })
})

describe('the core routes of the shared store', () => {
  it('asks the store, not an engine, where models go, and asks the given engine for its verdict', async () => {
    invokeMock.mockResolvedValue({ root: LINUX_ROOT, free_bytes: 1 })
    await expect(managedModelLocation()).resolves.toEqual({ root: LINUX_ROOT, free_bytes: 1 })
    expect(invokeMock).toHaveBeenLastCalledWith('atomic_core_call', {
      method: 'GET',
      path: '/managed-models/location',
      body: null,
    })

    invokeMock.mockResolvedValue(verdict(true))
    const request = { repository: 'r/m', revision: SHA, config_json: {}, hf_quant_config_json: null, files: [] }
    await checkManagedModel('second-engine', request)
    expect(invokeMock).toHaveBeenLastCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/second-engine/check',
      body: request,
    })
  })
})

describe('a check sees the settings the person set', () => {
  it("hands the engine's settings to the core before asking for the verdict", async () => {
    const order: string[] = []
    engines.set('vllm', {
      prepareCoreSettings: vi.fn(async () => {
        order.push('settings')
      }),
    })
    invokeMock.mockImplementation(async () => {
      order.push('check')
      return verdict(true)
    })
    const request = { repository: 'r/m', revision: SHA, config_json: {}, hf_quant_config_json: null, files: [] }
    await checkManagedModel('vllm', request)
    expect(order).toEqual(['settings', 'check'])
    engines.clear()
  })

  it('asks all the same when the engine is not loaded', async () => {
    invokeMock.mockResolvedValue(verdict(true))
    const request = { repository: 'r/m', revision: SHA, config_json: {}, hf_quant_config_json: null, files: [] }
    await expect(checkManagedModel('vllm', request)).resolves.toEqual(verdict(true))
  })
})
