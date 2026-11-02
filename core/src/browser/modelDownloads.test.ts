import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  atomicDownloadFiles,
  atomicHfSource,
  prepareAtomicDownload,
  readAtomicDownloadPlan,
  saveAtomicDownloadPlan,
  beginAtomicModelPreparation,
  cancelAtomicModelPreparation,
} from './modelDownloads'
import {
  atomicModelCatalogBaseline,
  clearAtomicModelCatalogCache,
  loadAtomicModelCatalog,
  atomicModelCatalogStatus,
  atomicModelCatalogSnapshot,
  loadAtomicModelCollection,
} from './modelCatalog'
import {
  atomicModelRevision,
  parseAtomicModelCatalog,
  projectAtomicModelCollection,
} from './catalogProtocol'
import { atomicAuxiliaryFile, atomicAuxiliaryModel } from './modelAuxiliary'

const A = 'a'.repeat(40),
  B = 'b'.repeat(40),
  HASH = 'c'.repeat(64)
const item = (path: string, repo = 'o/r') => ({
  url: `https://huggingface.co/${repo}/resolve/main/${path}`,
  save_path: `/models/${path}`,
})
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  })
  clearAtomicModelCatalogCache()
})

describe('immutable model plans', () => {
  it('resolves each repository once, pins every shard/config, and keeps independent projectors', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      const projector = String(url).includes('other/repo')
      return Response.json({
        sha: projector ? B : A,
        siblings: projector
          ? [{ rfilename: 'mmproj.gguf', lfs: { size: 5, sha256: HASH } }]
          : [
              { rfilename: 'model-00001-of-00002.gguf', lfs: { size: 4, sha256: HASH } },
              { rfilename: 'model-00002-of-00002.gguf', lfs: { size: 6, sha256: HASH } },
              { rfilename: 'config.json', size: 2 },
            ],
      })
    })
    const plan = await prepareAtomicDownload(
      [
        item('model-00001-of-00002.gguf'),
        item('model-00002-of-00002.gguf'),
        item('config.json'),
        item('mmproj.gguf', 'other/repo'),
      ],
      { fetch: request, revisionFor: () => undefined }
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(plan.files.map((f) => [atomicHfSource(f.url)?.revision, f.size])).toEqual([
      [A, 4],
      [A, 6],
      [A, 2],
      [B, 5],
    ])
    expect(plan.files[0].sha256).toBe(HASH)
  })
  it('executes the persisted plan after upstream and the current catalog change', async () => {
    const request = vi.fn(async () =>
      Response.json({ sha: A, siblings: [{ rfilename: 'm.gguf', lfs: { size: 4, sha256: HASH } }] })
    )
    const first = await atomicDownloadFiles('job', [item('m.gguf')], false, {
      fetch: request,
      revisionFor: () => undefined,
      token: 'secret',
    })
    request.mockRejectedValue(new Error('offline'))
    const resumed = await atomicDownloadFiles('job', [item('another.gguf')], true, {
      fetch: request,
      revisionFor: () => B,
    })
    expect(resumed).toEqual(first)
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(readAtomicDownloadPlan('job'))).not.toContain('secret')
  })
  it('rejects legacy main jobs without touching their stored data or reaching HF', async () => {
    const request = vi.fn()
    await expect(
      atomicDownloadFiles('old', [item('m.gguf')], true, { fetch: request })
    ).rejects.toThrow('no recorded model commit')
    expect(request).not.toHaveBeenCalled()
    expect(readAtomicDownloadPlan('old')).toBeUndefined()
  })
  it('keeps a saved plan even if Resume receives a newer fully prepared plan', async () => {
    const old = {
      version: 1 as const,
      files: [
        {
          ...item('m.gguf'),
          url: `https://huggingface.co/o/r/resolve/${A}/m.gguf`,
          size: 4,
          source: { repo: 'o/r', revision: A, path: 'm.gguf' },
        },
      ],
    }
    saveAtomicDownloadPlan('existing', old)
    const newer = {
      ...old.files[0],
      url: `https://huggingface.co/o/r/resolve/${B}/m.gguf`,
      source: { repo: 'o/r', revision: B, path: 'm.gguf' },
    }
    expect(await atomicDownloadFiles('existing', [newer], true)).toEqual(old.files)
  })
  it('expands shards before metadata validation and refuses an incomplete set', async () => {
    const request = vi.fn(async () =>
      Response.json({ sha: A, siblings: [{ rfilename: 'm-00001-of-00002.gguf', size: 4 }] })
    )
    await expect(
      prepareAtomicDownload([item('m-00001-of-00002.gguf')], { fetch: request, expandGguf: true })
    ).rejects.toThrow('Missing file m-00002')
    expect(request).toHaveBeenCalledTimes(1)
    expect(readAtomicDownloadPlan('incomplete')).toBeUndefined()
  })
  it('cancels metadata preparation across the app and extension boundary', async () => {
    const preparation = beginAtomicModelPreparation('cancelled')
    const request: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    const pending = prepareAtomicDownload([item('m.gguf')], {
      fetch: request,
      signal: preparation.signal,
    })
    cancelAtomicModelPreparation('cancelled')
    await expect(pending).rejects.toThrow()
    preparation.finish()
  })
  it.each([undefined, 'main', 'a'.repeat(39), B])(
    'rejects malformed or substituted commit %s',
    async (sha) => {
      await expect(
        prepareAtomicDownload(
          [{ ...item('m.gguf'), url: `https://huggingface.co/o/r/resolve/${A}/m.gguf` }],
          {
            fetch: async () => Response.json({ sha, siblings: [{ rfilename: 'm.gguf', size: 4 }] }),
          }
        )
      ).rejects.toThrow('did not confirm commit')
    }
  )
  it('rejects mismatched catalog expectations and strips proxy credentials from saved plans', async () => {
    const fetch = async () =>
      Response.json({ sha: A, siblings: [{ rfilename: 'm.gguf', lfs: { size: 4, sha256: HASH } }] })
    await expect(
      prepareAtomicDownload([{ ...item('m.gguf'), size: 5 }], {
        fetch,
        revisionFor: () => undefined,
      })
    ).rejects.toThrow('Catalog size disagrees')
    const plan = await prepareAtomicDownload(
      [{ ...item('m.gguf'), proxy: { password: 'secret' } }],
      { fetch, revisionFor: () => undefined }
    )
    Object.assign(plan.files[0].source!, { token: 'secret' })
    saveAtomicDownloadPlan('safe', plan)
    expect(JSON.stringify(readAtomicDownloadPlan('safe'))).not.toContain('secret')
    expect(atomicHfSource('https://example.com/file')).toBeUndefined()
    expect(() =>
      atomicHfSource('https://huggingface.co/o/r/resolve/main/dir/%2e%2e%2ffile')
    ).toThrow('Invalid')
  })
})

describe('unified catalog contract and fallback', () => {
  it('prepares the pinned Kimi draft from the real single-weight layout in the bundled catalog', async () => {
    const source = atomicAuxiliaryModel('auxiliary:mlx-dflash:kimi-k2.6')
    const revision = '3401c5c9bbd1e1989529bc36a334fa3d3d39691d'
    const hash = '9a6003bc678a24364d5d4ec1e6e23fa0e616e68c5ef3cc59725a622f56125f66'
    const request = vi.fn(async () =>
      Response.json({
        sha: revision,
        siblings: [
          { rfilename: 'config.json', size: 1326 },
          { rfilename: 'model.safetensors', lfs: { size: 6958561592, sha256: hash } },
        ],
      })
    )
    const items = source.required.map((path) => ({
      url: `https://huggingface.co/${source.repo}/resolve/${source.revision}/${path}`,
      save_path: `/drafts/kimi/${path}`,
    }))
    const files = await atomicDownloadFiles('kimi-draft', items, false, { fetch: request })
    expect(files.map((file) => file.source?.path)).toEqual(['config.json', 'model.safetensors'])
    expect(files[1]).toMatchObject({ size: 6958561592, sha256: hash, source: { revision } })
    expect(readAtomicDownloadPlan('kimi-draft')?.files).toEqual(files)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps voice and draft variant IDs when conf moves their source or filename', () => {
    const catalog = structuredClone(atomicModelCatalogBaseline())
    for (const role of ['voice', 'draft']) {
      const [id, entry] = Object.entries(catalog.models).find(
        ([, model]) =>
          model.kind === 'auxiliary' &&
          model.definition.role === role &&
          Object.values(model.variants).some((file) => file.path)
      )!
      const oldRepo = entry.definition.repo as string
      const [variant, file] = Object.entries(entry.variants).find(([, file]) => file.path)!
      entry.definition.repo = `moved/${role}`
      entry.definition.revision = B
      file.path = `weights/${role}.gguf`
      localStorage.setItem('atomic_unified_model_catalog_v1', JSON.stringify({ catalog }))
      expect(atomicAuxiliaryModel(id).revision).toBe(B)
      expect(atomicAuxiliaryFile(oldRepo, variant)).toMatchObject({
        repo: `moved/${role}`,
        revision: B,
        draftFilename: `weights/${role}.gguf`,
        draftSize: file.size,
      })
    }
  })
  it('retains all production GenieX and audio models in the fallback', () => {
    const catalog = atomicModelCatalogBaseline()
    const geniex = projectAtomicModelCollection(catalog, 'geniex-models').models as Array<{
      id: string
    }>
    const audio = projectAtomicModelCollection(catalog, 'audio').models as Array<{ id: string }>
    expect(geniex.map((model) => model.id)).toEqual([
      'qwen3-4b',
      'gemma-4-e2b',
      'gemma-4-e4b',
      'qwen3-4b-qairt',
    ])
    expect(audio).toHaveLength(4)
    expect(audio.some((model) => model.id === 'qwen3-tts-1.7b-customvoice')).toBe(true)
  })
  it('projects every collection, validates references and keeps each source revision', () => {
    const catalog = atomicModelCatalogBaseline()
    expect(parseAtomicModelCatalog(catalog)).toEqual(catalog)
    for (const name of Object.keys(catalog.collections))
      expect(projectAtomicModelCollection(catalog, name).schema_version).toBe(1)
    const family = (
      projectAtomicModelCollection(catalog, 'diffusion').families as Array<{
        transformer: { revision: string }
        vae: { revision: string }
      }>
    )[0]
    expect(family.transformer.revision).not.toBe(family.vae.revision)
    expect(atomicModelRevision(catalog, 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF')).toMatch(
      /^[0-9a-f]{40}$/
    )
    const broken = structuredClone(catalog)
    broken.collections['staff-picks'].entries!.push({ model: 'missing', variant: 'default' })
    expect(() => parseAtomicModelCatalog(broken)).toThrow('Unknown catalog model')
  })
  it('fetches one complete document for all adapters and uses the same cached snapshot offline', async () => {
    const catalog = atomicModelCatalogBaseline()
    const request = vi.fn(async () => Response.json(catalog))
    await loadAtomicModelCatalog({ fetch: request })
    expect(atomicModelCatalogStatus().source).toBe('remote')
    await loadAtomicModelCollection('recommended', { fetch: request })
    await loadAtomicModelCollection('diffusion', { fetch: request })
    expect(request).toHaveBeenCalledTimes(1)
    expect(atomicModelCatalogSnapshot()).toEqual(catalog)
    request.mockRejectedValue(new Error('offline'))
    expect(await loadAtomicModelCatalog({ fetch: request, force: true })).toEqual(catalog)
    expect(atomicModelCatalogStatus().source).toBe('cache')
    clearAtomicModelCatalogCache()
    await loadAtomicModelCatalog({ fetch: request })
    expect(atomicModelCatalogStatus().source).toBe('baseline')
  })
})
