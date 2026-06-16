import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import llamacpp_extension from '../index'
import {
  isBackendInstalled,
  getLocalInstalledBackends,
  isConcreteOfCudaFamily,
  fetchRemoteBackends,
} from '../backend'

// ATO-176: covers the graceful backend resolution/fallback chain in
// `ensureUsableBackend`. The backend module is mocked so we can simulate an
// unavailable requested tag (404 / empty-stub folder) alongside an already
// installed compatible backend on disk.
vi.mock('../backend', () => ({
  isBackendInstalled: vi.fn(),
  getBackendExePath: vi.fn(),
  getBackendDir: vi.fn(),
  listSupportedBackends: vi.fn(),
  getLocalInstalledBackends: vi.fn(),
  fetchRemoteBackends: vi.fn(),
  isConcreteOfCudaFamily: vi.fn(() => false),
  resolveCudaFamilyConcrete: vi.fn(() => null),
  friendlyBackendLabel: vi.fn((s: string) => s),
  getBackendDownloadUrl: vi.fn(),
  getCudartDownloadUrl: vi.fn(),
  getCudartArchiveName: vi.fn(),
  getCudaToolkitVersion: vi.fn(),
}))

// Silence the Tauri logging bridge (it calls invoke on a missing
// __TAURI_INTERNALS__ in the test env).
vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}))

describe('ensureUsableBackend (ATO-176)', () => {
  let extension: llamacpp_extension

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_WINDOWS', false)
    vi.stubGlobal('IS_MAC', true)
    vi.stubGlobal('IS_LINUX', false)
    extension = new llamacpp_extension()
    // `config` is populated during onLoad in the real flow; seed a minimal
    // bag so persistVersionBackend has a target.
    ;(extension as never as { config: Record<string, unknown> }).config = {
      version_backend: '',
    }
    vi.mocked(getLocalInstalledBackends).mockResolvedValue([] as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('falls back to the newest installed copy of the same variant when the requested concrete tag is unavailable (empty-stub / 404)', async () => {
    vi.mocked(isBackendInstalled).mockResolvedValue(false)
    vi.mocked(getLocalInstalledBackends).mockResolvedValue([
      { version: 'b9652', backend: 'macos-arm64', order: 0 },
    ] as never)
    vi.mocked(isConcreteOfCudaFamily).mockReturnValue(false)
    const dl = vi
      .spyOn(extension as never as { downloadAndInstallBackend: () => unknown }, 'downloadAndInstallBackend')
      .mockRejectedValue(new Error('HTTP status 404 Not Found'))

    const result = await (
      extension as never as {
        ensureUsableBackend: (
          b: string,
          v: string
        ) => Promise<{ version: string; backend: string }>
      }
    ).ensureUsableBackend('macos-arm64', 'b9642')

    expect(result).toEqual({ version: 'b9652', backend: 'macos-arm64' })
    expect(dl).toHaveBeenCalled()
    expect(
      (extension as never as { config: { version_backend: string } }).config
        .version_backend
    ).toBe('b9652/macos-arm64')
  })

  it('resolves the latest/<backend> sentinel to a concrete release tag before any download', async () => {
    vi.mocked(fetchRemoteBackends).mockResolvedValue([
      { version: 'b9700', backend: 'macos-arm64' },
    ] as never)
    vi.mocked(isBackendInstalled).mockResolvedValue(true)
    const dl = vi.spyOn(
      extension as never as { downloadAndInstallBackend: () => unknown },
      'downloadAndInstallBackend'
    )

    const result = await (
      extension as never as {
        ensureUsableBackend: (
          b: string,
          v: string
        ) => Promise<{ version: string; backend: string }>
      }
    ).ensureUsableBackend('macos-arm64', 'latest')

    expect(result).toEqual({ version: 'b9700', backend: 'macos-arm64' })
    // already installed → the unresolved 'latest' tag never reaches download
    expect(dl).not.toHaveBeenCalled()
  })

  it('throws a clear error only when the tag is unavailable and nothing is installed', async () => {
    vi.mocked(isBackendInstalled).mockResolvedValue(false)
    vi.mocked(getLocalInstalledBackends).mockResolvedValue([] as never)
    vi.spyOn(
      extension as never as { downloadAndInstallBackend: () => unknown },
      'downloadAndInstallBackend'
    ).mockRejectedValue(new Error('HTTP status 404 Not Found'))

    await expect(
      (
        extension as never as {
          ensureUsableBackend: (b: string, v: string) => Promise<unknown>
        }
      ).ensureUsableBackend('macos-arm64', 'b9642')
    ).rejects.toThrow(/unavailable/i)
  })
})
