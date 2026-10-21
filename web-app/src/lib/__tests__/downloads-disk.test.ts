import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An in-memory data folder: absolute path → file size, folders implied by the
 * paths. `file://<relative>` resolves against it, as the Rust commands do.
 */
const disk = vi.hoisted(() => {
  const DATA = '/data'
  const files = new Map<string, number>()
  const resolve = (path: string) =>
    path.startsWith('file://')
      ? `${DATA}/${path.slice('file://'.length)}`
      : path
  const isDir = (path: string) =>
    [...files.keys()].some((file) => file.startsWith(`${path}/`))
  const removed: string[] = []
  return {
    DATA,
    files,
    removed,
    fs: {
      readdirSync: vi.fn(async (raw: string) => {
        const path = resolve(raw)
        if (!isDir(path)) throw new Error(`no such folder: ${path}`)
        const children = new Set<string>()
        for (const file of files.keys()) {
          if (!file.startsWith(`${path}/`)) continue
          children.add(`${path}/${file.slice(path.length + 1).split('/')[0]}`)
        }
        return [...children]
      }),
      fileStat: vi.fn(async (path: string) =>
        files.has(path)
          ? { isDirectory: false, size: files.get(path)! }
          : isDir(path)
            ? { isDirectory: true, size: 0 }
            : undefined
      ),
      existsSync: vi.fn(async (path: string) => files.has(path) || isDir(path)),
      rm: vi.fn(async (path: string) => {
        removed.push(path)
        for (const file of [...files.keys()]) {
          if (file === path || file.startsWith(`${path}/`)) files.delete(file)
        }
      }),
    },
  }
})

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janhq/core')>()),
  fs: disk.fs,
}))

import {
  findMlxDrafts,
  findPartialDownloads,
  mlxModelFolderBytes,
  readDiskTree,
  removeDiskPaths,
  scanDownloadsDisk,
  type DiskDir,
} from '../downloads-disk'

const MB = 1024 ** 2
const GB = 1024 ** 3

const put = (relative: string, bytes: number) =>
  disk.files.set(`${disk.DATA}/${relative}`, bytes)

beforeEach(() => {
  vi.clearAllMocks()
  disk.files.clear()
  disk.removed.length = 0
})

describe('scanDownloadsDisk', () => {
  beforeEach(() => {
    // An installed llama.cpp model, and one whose download never finished.
    put('llamacpp/models/unsloth/Qwen3.5-4B-Q4_K_M/model.yml', 300)
    put('llamacpp/models/unsloth/Qwen3.5-4B-Q4_K_M/model.gguf', 2.5 * GB)
    put(
      'llamacpp/models/Meta-Llama-3_1-8B-Instruct-IQ4_XS/model.gguf.tmp',
      3 * GB
    )
    put('llamacpp/models/Meta-Llama-3_1-8B-Instruct-IQ4_XS/model.gguf.url', 120)
    // An installed model whose projector download stopped half way.
    put('llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/model.yml', 300)
    put('llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/model.gguf', 4 * GB)
    put(
      'llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/mmproj.gguf.tmp',
      200 * MB
    )
    put('llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/mmproj.gguf.url', 120)
    // MLX: a downloaded model whose model.yml recorded no size…
    put('mlx/models/gemma-4-e4b-it-4bit/model.yml', 200)
    put('mlx/models/gemma-4-e4b-it-4bit/model.safetensors', 4.9 * GB)
    put('mlx/models/gemma-4-e4b-it-4bit/config.json', 4000)
    // …an import whose weights stay elsewhere…
    put('mlx/models/imported-elsewhere/model.yml', 200)
    // …a download that stopped before its model.yml, with a subfolder…
    put('mlx/models/Qwen3.5-27B-OptiQ-4bit/config.json', 2000)
    put('mlx/models/Qwen3.5-27B-OptiQ-4bit/model.safetensors.tmp', 90 * MB)
    put('mlx/models/Qwen3.5-27B-OptiQ-4bit/model.safetensors.url', 100)
    put('mlx/models/Qwen3.5-27B-OptiQ-4bit/optiq/layers.json', 5 * MB)
    // …a DFlash draft imported as a folder, and the cached drafts.
    put('mlx/models/z-lab_Qwen3.5-9B-DFlash/config.json', 1000)
    put('mlx/models/z-lab_Qwen3.5-9B-DFlash/model.safetensors', 2 * GB)
    put('mlx/models/z-lab_Qwen3.5-9B-DFlash/assets/speedup.png', 65_000)
    put('mlx/draft-models/z-lab/Qwen3.5-4B-DFlash/config.json', 1000)
    put('mlx/draft-models/z-lab/Qwen3.5-4B-DFlash/model.safetensors', 1 * GB)
    put(
      'mlx/draft-models/mlx-community/gemma-4-E2B-it-assistant-bf16/config.json',
      1000
    )
    put(
      'mlx/draft-models/mlx-community/gemma-4-E2B-it-assistant-bf16/model.safetensors.tmp',
      100 * MB
    )
  })

  it('sizes an unsized MLX model from its folder, and not an import it does not hold', async () => {
    const scan = await scanDownloadsDisk([
      'gemma-4-e4b-it-4bit',
      'imported-elsewhere',
      'not-on-disk',
    ])

    expect(scan.mlxModelBytes).toEqual({
      'gemma-4-e4b-it-4bit': 4.9 * GB + 200 + 4000,
    })
  })

  it('finds every download that left partial files, and what removing it takes', async () => {
    const scan = await scanDownloadsDisk([])
    const byId = Object.fromEntries(scan.partials.map((p) => [p.id, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'Meta-Llama-3_1-8B-Instruct-IQ4_XS',
      'Qwen3.5-27B-OptiQ-4bit',
      'google/gemma-4-E4B-it-IQ4_XS',
      'mlx-community/gemma-4-E2B-it-assistant-bf16',
    ])
    // Nothing was ever installed there: the whole folder goes, subfolders too.
    expect(byId['Meta-Llama-3_1-8B-Instruct-IQ4_XS']).toEqual({
      root: 'llamacpp/models',
      id: 'Meta-Llama-3_1-8B-Instruct-IQ4_XS',
      paths: [`${disk.DATA}/llamacpp/models/Meta-Llama-3_1-8B-Instruct-IQ4_XS`],
      bytes: 3 * GB + 120,
    })
    expect(byId['Qwen3.5-27B-OptiQ-4bit'].paths).toEqual([
      `${disk.DATA}/mlx/models/Qwen3.5-27B-OptiQ-4bit`,
    ])
    expect(byId['Qwen3.5-27B-OptiQ-4bit'].bytes).toBe(
      2000 + 90 * MB + 100 + 5 * MB
    )
    // Beside an installed model only the partial files go.
    expect(byId['google/gemma-4-E4B-it-IQ4_XS'].paths.sort()).toEqual([
      `${disk.DATA}/llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/mmproj.gguf.tmp`,
      `${disk.DATA}/llamacpp/models/google/gemma-4-E4B-it-IQ4_XS/mmproj.gguf.url`,
    ])
    expect(byId['google/gemma-4-E4B-it-IQ4_XS'].bytes).toBe(200 * MB + 120)
    // A draft still downloading is a partial download of the drafts folder.
    expect(byId['mlx-community/gemma-4-E2B-it-assistant-bf16'].root).toBe(
      'mlx/draft-models'
    )
  })

  it('lists the complete MLX drafts, cached or imported, and no model as one', async () => {
    const scan = await scanDownloadsDisk([])

    expect(
      scan.drafts.map(({ id, path, bytes }) => ({ id, path, bytes }))
    ).toEqual([
      {
        id: 'z-lab/Qwen3.5-4B-DFlash',
        path: `${disk.DATA}/mlx/draft-models/z-lab/Qwen3.5-4B-DFlash`,
        bytes: 1 * GB + 1000,
      },
      {
        id: 'z-lab_Qwen3.5-9B-DFlash',
        path: `${disk.DATA}/mlx/models/z-lab_Qwen3.5-9B-DFlash`,
        bytes: 1000 + 2 * GB + 65_000,
      },
    ])
  })

  it('reads nothing where the download folders are missing', async () => {
    disk.files.clear()

    expect(await scanDownloadsDisk(['gemma-4-e4b-it-4bit'])).toEqual({
      mlxModelBytes: {},
      partials: [],
      drafts: [],
    })
  })
})

describe('the disk rules', () => {
  const dir = (
    name: string,
    files: Record<string, number>,
    dirs: DiskDir[] = [],
    truncated = false
  ): DiskDir => ({
    path: `/x/${name}`,
    name,
    files: Object.entries(files).map(([file, bytes]) => ({
      path: `/x/${name}/${file}`,
      name: file,
      bytes,
    })),
    dirs,
    ...(truncated ? { truncated } : {}),
  })

  it('never takes a folder whole when a model is installed anywhere in it', () => {
    const root = dir('models', {}, [
      dir('org', { 'model.gguf.parts': 10 }, [
        dir('quant', { 'model.yml': 1, 'model.gguf': 100 }),
      ]),
    ])

    expect(findPartialDownloads(root, 'llamacpp/models')).toEqual([
      {
        root: 'llamacpp/models',
        id: 'org',
        paths: ['/x/org/model.gguf.parts'],
        bytes: 10,
      },
    ])
  })

  it('never takes a subfolder of an installed model whole', () => {
    const root = dir('models', {}, [
      dir('gemma', { 'model.yml': 1, 'model.safetensors': 100 }, [
        dir('assets', { 'tokenizer.json': 7, 'logo.png.tmp': 3 }),
      ]),
    ])

    expect(findPartialDownloads(root, 'mlx/models')).toEqual([
      {
        root: 'mlx/models',
        id: 'gemma/assets',
        paths: ['/x/assets/logo.png.tmp'],
        bytes: 3,
      },
    ])
  })

  it('never takes a folder whole when part of it was not read', () => {
    const root = dir('models', {}, [
      dir(
        'deep',
        { 'model.gguf.tmp': 10, 'model.gguf.parts.new': 5 },
        [],
        true
      ),
    ])

    expect(findPartialDownloads(root, 'llamacpp/models')[0].paths).toEqual([
      '/x/deep/model.gguf.tmp',
      '/x/deep/model.gguf.parts.new',
    ])
  })

  it("counts an MLX model's folder without a download's partial files in it", () => {
    const models = dir('models', {}, [
      dir('m', {
        'model.yml': 1,
        'model.safetensors': 100,
        'model.safetensors.tmp': 50,
      }),
    ])

    expect(mlxModelFolderBytes(models, 'm')).toBe(101)
  })

  it('takes an unlisted folder for a draft only when it is named as one', () => {
    const models = dir('models', {}, [
      dir('some-model-4bit', { 'config.json': 1, 'model.safetensors': 9 }),
    ])

    expect(findMlxDrafts(models, null)).toEqual([])
  })
})

describe('readDiskTree', () => {
  it('stops at the depth limit and says so', async () => {
    put('a/b/c/file.bin', 1)

    const tree = await readDiskTree('file://a', 1)

    expect(tree?.dirs[0].name).toBe('b')
    expect(tree?.dirs[0].truncated).toBe(true)
    expect(tree?.dirs[0].dirs).toEqual([])
  })

  it('reads as nothing when the data folder commands are not there', async () => {
    disk.fs.readdirSync.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'api')")
    })

    expect(await readDiskTree('file://llamacpp/models')).toBeNull()
  })
})

describe('removeDiskPaths', () => {
  it('deletes what it is given and skips what is already gone', async () => {
    put('llamacpp/models/x/model.gguf.tmp', 10)
    put('llamacpp/models/x/model.gguf.url', 1)

    await removeDiskPaths([
      `${disk.DATA}/llamacpp/models/x/model.gguf.tmp`,
      `${disk.DATA}/llamacpp/models/x/gone.tmp`,
    ])

    expect(disk.removed).toEqual([
      `${disk.DATA}/llamacpp/models/x/model.gguf.tmp`,
    ])
    expect([...disk.files.keys()]).toEqual([
      `${disk.DATA}/llamacpp/models/x/model.gguf.url`,
    ])
  })
})
