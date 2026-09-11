import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

import { seedServiceHub } from '@/test/service-hub'
import type { AppService } from '@/services/app/types'
import type { HardwareService } from '@/services/hardware/types'
import type {
  DiffusionBackendInstallRecord,
  DiffusionService,
} from '@/services/diffusion/types'

import {
  assetUrl,
  backendInstallDir,
  clearSdcppManifestCache,
  diffusionBackendTaskId,
  ensureDiffusionBackend,
  getBaselineSdcppManifest,
  parseSdcppManifest,
  resolveSdcppManifest,
  selectDiffusionBackendForHost,
  stripAtomicTagSuffix,
  type SdcppManifest,
} from '../install'

const HASH = 'c'.repeat(64)

const manifest: SdcppManifest = {
  upstream_repo: 'leejet/stable-diffusion.cpp',
  tag_name: 'master-849-d04e895',
  assets: [
    { backend: 'macos-arm64', name: 'sd-master-d04e895-bin-Darwin-macOS-26.6.2-arm64.zip', sha256: HASH, size: 50_032_742 },
    { backend: 'win-cuda12-x64', name: 'sd-master-d04e895-bin-win-cuda12-x64.zip', sha256: HASH, size: 336_414_089 },
    { backend: 'win-cpu-x64', name: 'sd-master-d04e895-bin-win-cpu-x64.zip', sha256: HASH, size: 24_112_084 },
    { backend: 'win-cudart-cu12', name: 'cudart-sd-bin-win-cu12-x64.zip', sha256: HASH, size: 563_452_046, companion: true },
  ],
}

const MIRROR = 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download'

describe('assetUrl', () => {
  it('uses the signed mirror when the manifest names one', () => {
    expect(assetUrl({ ...manifest, download_base: MIRROR }, manifest.assets[1])).toBe(
      `${MIRROR}/master-849-d04e895/sd-master-d04e895-bin-win-cuda12-x64.zip`
    )
  })

  it('falls back to the upstream release otherwise', () => {
    expect(assetUrl(manifest, manifest.assets[0])).toBe(
      'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-849-d04e895/sd-master-d04e895-bin-Darwin-macOS-26.6.2-arm64.zip'
    )
  })

  it('strips the Atomic variant suffix from the upstream tag only', () => {
    const variant = { ...manifest, tag_name: 'master-849-d04e895-a1b2c3d4' }
    expect(assetUrl(variant, manifest.assets[2])).toContain(
      '/releases/download/master-849-d04e895/'
    )
    expect(assetUrl({ ...variant, download_base: MIRROR }, manifest.assets[2])).toContain(
      `${MIRROR}/master-849-d04e895-a1b2c3d4/`
    )
    expect(stripAtomicTagSuffix('master-849-d04e895')).toBe('master-849-d04e895')
  })

  it('defaults the upstream repo when the manifest omits it', () => {
    const { upstream_repo: _repo, ...bare } = manifest
    expect(assetUrl(bare, manifest.assets[2])).toMatch(
      /^https:\/\/github\.com\/leejet\/stable-diffusion\.cpp\//
    )
  })
})

describe('paths and ids', () => {
  it('installs under diffusion/backends/<tag>/<backendId>', () => {
    expect(backendInstallDir('/Users/me/atomic', 'master-849-d04e895', 'macos-arm64')).toBe(
      '/Users/me/atomic/diffusion/backends/master-849-d04e895/macos-arm64'
    )
    expect(backendInstallDir('C:\\Users\\me\\atomic', 'master-849-d04e895', 'win-cpu-x64')).toBe(
      'C:\\Users\\me\\atomic\\diffusion\\backends\\master-849-d04e895\\win-cpu-x64'
    )
  })

  it('makes a task id Tauri accepts as an event name', () => {
    const id = diffusionBackendTaskId('master-849-d04e895-a1b2c3d4', 'win-rocm-7.14-x64')
    expect(id).toBe('diffusion-backend-master-849-d04e895-a1b2c3d4-win-rocm-7_14-x64')
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('parseSdcppManifest', () => {
  it('drops assets it could not download safely and unknown keys', () => {
    const parsed = parseSdcppManifest({
      $schema: './sdcpp-schema.json',
      tag_name: 'master-849-d04e895',
      download_base: 'https://mirror.example/releases/',
      assets: [
        { backend: 'win-cpu-x64', name: 'sd-win-cpu-x64.zip', sha256: HASH, size: 1, extra: true },
        { backend: 'win-cpu-x64', name: 'duplicate.zip' },
        { backend: 'linux-cpu-x64', name: '../escape.zip' },
        { backend: 'linux-vulkan-x64', name: 'sd-linux.tar.gz', sha256: 'nope', size: -1 },
      ],
    })
    expect(parsed).toEqual({
      tag_name: 'master-849-d04e895',
      download_base: 'https://mirror.example/releases',
      assets: [
        { backend: 'win-cpu-x64', name: 'sd-win-cpu-x64.zip', sha256: HASH, size: 1 },
        { backend: 'linux-vulkan-x64', name: 'sd-linux.tar.gz' },
      ],
    })
  })

  it('rejects a manifest without a usable tag or asset', () => {
    expect(() => parseSdcppManifest({ tag_name: 'v 1', assets: [] })).toThrow(/tag_name/)
    expect(() => parseSdcppManifest({ tag_name: 'b1', assets: [{ name: 'x.zip' }] })).toThrow(
      /no usable asset/
    )
  })

  it('validates the bundled baseline', () => {
    const baseline = getBaselineSdcppManifest()
    expect(baseline.tag_name).toMatch(/^master-\d+-[0-9a-f]{7}/)
    expect(baseline.assets.map((a) => a.backend)).toContain('macos-arm64')
  })
})

describe('resolveSdcppManifest', () => {
  const URL_ = 'https://example.test/sdcpp-manifest.json'

  beforeEach(() => clearSdcppManifestCache())
  afterEach(() => vi.restoreAllMocks())

  const fetchOk = (body: unknown) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    })) as unknown as typeof fetch
  }

  it('serves the remote manifest and then the cache', async () => {
    fetchOk(manifest)
    const first = await resolveSdcppManifest({ url: URL_ })
    expect(first.source).toBe('remote')
    expect(first.manifest.tag_name).toBe('master-849-d04e895')

    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const second = await resolveSdcppManifest({ url: URL_ })
    expect(second.source).toBe('cache')
    expect(second.manifest.assets).toHaveLength(4)
  })

  it('falls back to the bundled baseline with the error attached', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await resolveSdcppManifest({ url: URL_ })
    expect(result.source).toBe('baseline')
    expect(result.error).toBe('offline')
    expect(result.manifest).toEqual(getBaselineSdcppManifest())
  })
})

describe('ensureDiffusionBackend', () => {
  const invoked: Array<[string, InvokeArgs | undefined]> = []
  const transfers: Array<{ items: unknown[]; taskId: string }> = []
  let finalized: unknown
  let removed: string[]
  let installedRecords: DiffusionBackendInstallRecord[]

  const record = (tag: string, backendId: string): DiffusionBackendInstallRecord => ({
    tag,
    backendId,
    backend: 'cpu',
    engine: 'sd-cpp',
    sha256: null,
    installedAtMs: 1,
    dir: `/data/diffusion/backends/${tag}/${backendId}`,
  })

  beforeEach(() => {
    clearSdcppManifestCache()
    invoked.length = 0
    transfers.length = 0
    finalized = undefined
    removed = []
    installedRecords = []

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => manifest,
    })) as unknown as typeof fetch

    mockIPC((command: string, args?: InvokeArgs) => {
      invoked.push([command, args])
      if (command === 'plugin:llamacpp-upstream|get_supported_features') {
        return { cuda12: true, vulkan: true }
      }
      if (command === 'plugin:llamacpp-upstream|available_disk_space') {
        return 10 * 1024 ** 4
      }
      return undefined
    })

    const core = (globalThis as unknown as { core: Record<string, unknown> }).core
    core.api = {
      ...(core.api as Record<string, unknown>),
      existsSync: vi.fn(async () => false),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    }
    core.extensionManager = {
      getByName: (name: string) =>
        name === '@janhq/download-extension'
          ? {
              downloadFiles: async (
                items: unknown[],
                taskId: string,
                onProgress?: (t: number, total: number) => void
              ) => {
                transfers.push({ items, taskId })
                onProgress?.(5, 10)
                onProgress?.(10, 10)
              },
            }
          : undefined,
    }
    ;(window as unknown as { core: unknown }).core = core

    seedServiceHub({
      app: { getJanDataFolder: async () => '/data' } as unknown as AppService,
      hardware: {
        getHardwareInfo: async () => ({
          os_type: 'windows',
          cpu: { arch: 'x64', extensions: ['avx2'] },
          gpus: [{ vendor: 'NVIDIA', total_memory: 16384 }],
          total_memory: 65536,
        }),
      } as unknown as HardwareService,
      diffusion: {
        listInstalledBackends: async () => installedRecords,
        finalizeBackendInstall: async (args: unknown) => {
          finalized = args
          const a = args as { tag: string; backendId: string }
          return record(a.tag, a.backendId)
        },
        removeBackend: async (dir: string) => {
          removed.push(dir)
          if (dir.includes('busy')) {
            throw { code: 'BACKEND_IN_USE', message: 'busy' }
          }
        },
      } as unknown as DiffusionService,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads, unpacks and finalizes the backend the host qualifies for', async () => {
    const progress: number[] = []
    const result = await ensureDiffusionBackend({
      onProgress: ({ transferred }) => progress.push(transferred),
    })

    expect(result.backendId).toBe('win-cuda12-x64')
    expect(result.dir).toBe('/data/diffusion/backends/master-849-d04e895/win-cuda12-x64')
    expect(progress).toEqual([5, 10])

    // The CUDA build brings its runtime companion along, both from upstream.
    expect(transfers).toHaveLength(1)
    expect(transfers[0].taskId).toBe('diffusion-backend-master-849-d04e895-win-cuda12-x64')
    expect(transfers[0].items).toEqual([
      {
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-849-d04e895/sd-master-d04e895-bin-win-cuda12-x64.zip',
        save_path: '/data/diffusion/backends/tmp/sd-master-d04e895-bin-win-cuda12-x64.zip',
        sha256: HASH,
        size: 336_414_089,
        model_id: 'diffusion-backend-master-849-d04e895-win-cuda12-x64',
      },
      {
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-849-d04e895/cudart-sd-bin-win-cu12-x64.zip',
        save_path: '/data/diffusion/backends/tmp/cudart-sd-bin-win-cu12-x64.zip',
        sha256: HASH,
        size: 563_452_046,
        model_id: 'diffusion-backend-master-849-d04e895-win-cuda12-x64',
      },
    ])

    const decompressed = invoked
      .filter(([command]) => command === 'decompress')
      .map(([, args]) => args)
    expect(decompressed).toEqual([
      {
        path: '/data/diffusion/backends/tmp/sd-master-d04e895-bin-win-cuda12-x64.zip',
        outputDir: '/data/diffusion/backends/master-849-d04e895/win-cuda12-x64',
      },
      {
        path: '/data/diffusion/backends/tmp/cudart-sd-bin-win-cu12-x64.zip',
        outputDir: '/data/diffusion/backends/master-849-d04e895/win-cuda12-x64',
      },
    ])
    expect(finalized).toEqual({
      dir: '/data/diffusion/backends/master-849-d04e895/win-cuda12-x64',
      tag: 'master-849-d04e895',
      backendId: 'win-cuda12-x64',
      backend: 'cuda',
      engine: 'sd-cpp',
      sha256: HASH,
    })
  })

  it('returns the existing record without downloading again', async () => {
    installedRecords = [record('master-849-d04e895', 'win-cuda12-x64')]
    const result = await ensureDiffusionBackend()
    expect(result).toBe(installedRecords[0])
    expect(transfers).toEqual([])
    expect(finalized).toBeUndefined()
  })

  it('retires the previous tree after the new one is in, unless a session still runs from it', async () => {
    installedRecords = [
      { ...record('master-800-0000000', 'win-cpu-x64'), dir: '/data/diffusion/backends/old/win-cpu-x64' },
      { ...record('master-800-0000000', 'win-vulkan-x64'), dir: '/data/diffusion/backends/busy/win-vulkan-x64' },
    ]
    const result = await ensureDiffusionBackend()
    expect(result.backendId).toBe('win-cuda12-x64')
    expect(removed).toEqual([
      '/data/diffusion/backends/old/win-cpu-x64',
      '/data/diffusion/backends/busy/win-vulkan-x64',
    ])
    // The busy tree's refusal is not an install failure.
    expect(finalized).toMatchObject({ backendId: 'win-cuda12-x64' })
  })

  it('refuses when the disk cannot hold the archive and its unpacked tree', async () => {
    mockIPC((command: string) => {
      if (command === 'plugin:llamacpp-upstream|get_supported_features') return {}
      if (command === 'plugin:llamacpp-upstream|available_disk_space') return 1024
      return undefined
    })
    await expect(ensureDiffusionBackend()).rejects.toMatchObject({
      code: 'DISK_FULL',
    })
    expect(transfers).toEqual([])
  })

  it('names the host that no build serves', async () => {
    seedServiceHub({
      hardware: {
        getHardwareInfo: async () => ({
          os_type: 'macos',
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [],
          total_memory: 32768,
        }),
      } as unknown as HardwareService,
      diffusion: { listInstalledBackends: async () => [] } as unknown as DiffusionService,
    })
    await expect(selectDiffusionBackendForHost()).resolves.toEqual({
      backendId: null,
      reason: 'Image generation needs an Apple Silicon Mac; Intel Macs are not supported.',
    })
    await expect(ensureDiffusionBackend()).rejects.toMatchObject({
      code: 'UNSUPPORTED_BACKEND',
    })
  })
})
