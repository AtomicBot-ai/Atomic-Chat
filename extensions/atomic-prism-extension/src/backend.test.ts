import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fs, getJanDataFolderPath, joinPath } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import {
  cleanupIncompleteBackends,
  friendlyBackendLabel,
  getBackendDir,
  getLocalInstalledBackends,
  isBackendInstalled,
  loadCatalog,
  mergeBackendOptions,
  parsePrismArchiveName,
  parseVersionBackendSetting,
  prismTagBuild,
} from './backend'

const TAG = 'prism-b10754-2459f68'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getJanDataFolderPath).mockResolvedValue('/jan')
  vi.mocked(joinPath).mockImplementation((parts: string[]) =>
    Promise.resolve(parts.join('/'))
  )
})

describe('prismTagBuild', () => {
  it.each([
    [TAG, 10754],
    [`\uFEFF ${TAG} `, 10754],
    ['prism-b1-abcdef0', 1],
    ['b10754', null],
    ['prism-b10754', null],
    ['latest', null],
  ])('%j -> %j', (tag, build) => {
    expect(prismTagBuild(tag)).toBe(build)
  })
})

describe('parsePrismArchiveName', () => {
  it.each([
    [`llama-${TAG}-bin-macos-arm64.tar.gz`, 'macos-arm64'],
    [`llama-${TAG}-bin-macos-x64.tar.gz`, 'macos-x64'],
    [`llama-${TAG}-bin-ubuntu-x64.tar.gz`, 'linux-cpu-x64'],
    [`llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`, 'linux-vulkan-x64'],
    [`llama-${TAG}-bin-ubuntu-rocm-7.2-x64.tar.gz`, 'linux-rocm-7.2-x64'],
    [`llama-${TAG}-bin-linux-cuda-12.4-x64.tar.gz`, 'linux-cuda-12.4-x64'],
    [`llama-${TAG}-bin-linux-cuda-13.3-x64.tar.gz`, 'linux-cuda-13.3-x64'],
    [`llama-${TAG}-bin-win-cpu-x64.zip`, 'win-cpu-x64'],
    [`llama-${TAG}-bin-win-cuda-12.4-x64.zip`, 'win-cuda-12.4-x64'],
  ])('%s installs as %s', (name, backend) => {
    expect(parsePrismArchiveName(name)).toEqual({ version: TAG, backend })
  })

  it.each([
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'llama-b10754-bin-macos-arm64.tar.gz',
    `llama-${TAG}-bin-macos-arm64.7z`,
    `${TAG}.tar.gz`,
  ])('is not a PrismML server archive: %s', (name) => {
    expect(parsePrismArchiveName(name)).toBeNull()
  })
})

describe('friendlyBackendLabel', () => {
  it.each([
    ['linux-cpu-x64', 'CPU'],
    ['win-cpu-x64', 'CPU'],
    ['linux-cuda-12.4-x64', 'CUDA 12.4'],
    ['win-cuda-13.3-x64', 'CUDA 13.3'],
    ['linux-rocm-7.2-x64', 'ROCm 7.2'],
    ['linux-vulkan-x64', 'Vulkan'],
    ['macos-arm64', 'Apple Silicon'],
    ['macos-x64', 'Intel'],
    ['something-new', 'something-new'],
  ])('%s -> %s', (backend, label) => {
    expect(friendlyBackendLabel(backend)).toBe(label)
  })
})

describe('mergeBackendOptions', () => {
  const opt = (value: string, name = value) => ({ value, name })

  it('keeps the first spelling of a build and drops empties', () => {
    expect(
      mergeBackendOptions([
        [opt(`${TAG}/macos-arm64`, 'rich'), opt('')],
        [opt(`${TAG}/macos-arm64`, 'plain'), opt(`\uFEFF${TAG}/macos-x64`, 'Intel')],
      ])
    ).toEqual([opt(`${TAG}/macos-arm64`, 'rich'), opt(`${TAG}/macos-x64`, 'Intel')])
  })

  it('forces the recommendation in, first', () => {
    expect(
      mergeBackendOptions([[opt('a/b')]], opt(`${TAG}/linux-cpu-x64`))
    ).toEqual([opt(`${TAG}/linux-cpu-x64`), opt('a/b')])
    expect(mergeBackendOptions([[opt('a/b')]], opt('a/b'))).toEqual([opt('a/b')])
  })
})

describe('parseVersionBackendSetting', () => {
  it('reads a version/backend pair', () => {
    expect(parseVersionBackendSetting(`\uFEFF${TAG}/linux-cpu-x64`, 'linux-vulkan-x64')).toEqual({
      backend_type_updated: true,
      effective_backend_type: 'linux-cpu-x64',
      needs_backend_installation: true,
      version: TAG,
      backend: 'linux-cpu-x64',
    })
    expect(
      parseVersionBackendSetting(`${TAG}/linux-cpu-x64`, 'linux-cpu-x64').backend_type_updated
    ).toBe(false)
    expect(
      parseVersionBackendSetting(`${TAG}/linux-cpu-x64`, undefined).backend_type_updated
    ).toBe(true)
  })

  it.each(['none', 'a/b/c', '/x', 'x/ '])('rejects %j', (value) => {
    expect(() => parseVersionBackendSetting(value, undefined)).toThrow('Invalid backend format')
  })
})

describe('the core-backed reads', () => {
  it('asks the core for the catalog once, until refreshed or forced', async () => {
    const catalog = { provider: 'atomic-prism', available: [] }
    vi.mocked(invoke).mockResolvedValue(catalog)

    await expect(loadCatalog({ force: true, appVersion: '1.2.3' })).resolves.toBe(catalog)
    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/backends/atomic-prism/catalog',
      body: { force: true, app_version: '1.2.3', proxy: null },
    })

    await loadCatalog()
    expect(invoke).toHaveBeenCalledTimes(1)

    await loadCatalog({ refresh: true })
    expect(invoke).toHaveBeenLastCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/backends/atomic-prism/catalog',
      body: { force: false, app_version: null, proxy: null },
    })
  })

  it('lists installed packs as the core sees them', async () => {
    vi.mocked(invoke).mockResolvedValue({
      backends: [{ version: TAG, backend: 'macos-arm64', path: '/p', active: true }],
    })
    await expect(getLocalInstalledBackends()).resolves.toEqual([
      { version: TAG, backend: 'macos-arm64' },
    ])
  })
})

describe('the pack tree', () => {
  it('lives under atomic-prism/backends', async () => {
    await expect(getBackendDir(' linux-cpu-x64 ', `\uFEFF${TAG}`)).resolves.toBe(
      `/jan/atomic-prism/backends/${TAG}/linux-cpu-x64`
    )
  })

  it('finds llama-server under build/bin, or at the top of an old layout', async () => {
    const dir = `/jan/atomic-prism/backends/${TAG}/macos-arm64`
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
      [`${dir}/build`, `${dir}/build/bin/llama-server`].includes(path)
    )
    await expect(isBackendInstalled('macos-arm64', TAG)).resolves.toBe(true)

    vi.mocked(fs.existsSync).mockImplementation(
      async (path: string) => path === `${dir}/llama-server`
    )
    await expect(isBackendInstalled('macos-arm64', TAG)).resolves.toBe(true)
  })

  it('sweeps folders without a server, but not a staging install or a working pack', async () => {
    const root = '/jan/atomic-prism/backends'
    const tree: Record<string, string[]> = {
      [root]: [TAG, 'stray.txt'],
      [`${root}/${TAG}`]: ['linux-cpu-x64', 'linux-vulkan-x64', 'linux-cpu-x64.incoming-1'],
    }
    vi.mocked(fs.readdirSync).mockImplementation(async (path: string) => {
      if (path in tree) return tree[path]
      throw new Error('not a directory')
    })
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
      [
        root,
        `${root}/${TAG}/linux-cpu-x64/build`,
        `${root}/${TAG}/linux-cpu-x64/build/bin/llama-server`,
      ].includes(path)
    )
    vi.mocked(fs.rm).mockResolvedValue(undefined)

    await expect(cleanupIncompleteBackends()).resolves.toEqual([`${TAG}/linux-vulkan-x64`])
    expect(fs.rm).toHaveBeenCalledWith(`${root}/${TAG}/linux-vulkan-x64`)
    expect(fs.rm).not.toHaveBeenCalledWith(`${root}/${TAG}`)
  })

  it('removes a version folder the sweep left empty', async () => {
    const root = '/jan/atomic-prism/backends'
    let swept = false
    vi.mocked(fs.readdirSync).mockImplementation(async (path: string) => {
      if (path === root) return [TAG]
      return swept ? [] : ['linux-cpu-x64']
    })
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => path === root)
    vi.mocked(fs.rm).mockImplementation(async () => {
      swept = true
    })

    await expect(cleanupIncompleteBackends()).resolves.toEqual([`${TAG}/linux-cpu-x64`])
    expect(fs.rm).toHaveBeenLastCalledWith(`${root}/${TAG}`)
  })

  it('does nothing without a backends folder', async () => {
    vi.mocked(fs.existsSync).mockResolvedValue(false)
    await expect(cleanupIncompleteBackends()).resolves.toEqual([])
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })
})
