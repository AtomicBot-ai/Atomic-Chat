import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  fetchRemoteBackends,
  getBackendDownloadUrl,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { fs, getJanDataFolderPath } from '@janhq/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { emit as tauriEmit } from '@tauri-apps/api/event'

// Mock constants: Hardcode path string directly inside the mock to avoid hoisting issues
const MOCK_JAN_PATH_STRING = '/path/to/jan'

// Mock the core dependencies
vi.mock('@janhq/core', () => ({
  getJanDataFolderPath: vi.fn().mockResolvedValue('/path/to/jan'),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  joinPath: vi.fn(async (paths: string[]) => paths.join('/')),
  events: {
    emit: vi.fn(),
  },
}))
vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../util', () => ({
  getProxyConfig: vi.fn().mockReturnValue(null),
}))

vi.stubGlobal('IS_WINDOWS', false)

describe('Backend functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock getJanDataFolderPath explicitly to a simple path
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')

    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: {
        arch: 'x86_64',
        extensions: [],
      },
      gpus: [],
    } as any)

    // Default mock for isBackendInstalled dependencies
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path.includes('build')) return true
      return false
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getBackendDir and getBackendExePath', () => {
    it('should use the specific backend name for directory path', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('linux-avx2-x64', 'v1.2.3')
      expect(dir).toBe(`/path/to/jan/llamacpp/backends/v1.2.3/linux-avx2-x64`)

      const exePath = await getBackendExePath('linux-avx2-x64', 'v1.2.3')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp/backends/v1.2.3/linux-avx2-x64/build/bin/llama-server`
      )
    })

    it('should use the new common backend name for directory path if it was the asset name', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('win-common_cpus-x64', 'v2.0.0')
      expect(dir).toBe(
        `/path/to/jan/llamacpp/backends/v2.0.0/win-common_cpus-x64`
      )

      const exePath = await getBackendExePath('win-common_cpus-x64', 'v2.0.0')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp/backends/v2.0.0/win-common_cpus-x64/build/bin/llama-server`
      )
    })
  })

  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `/path/to/jan/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `/path/to/jan/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })

  // ATO-199 / GitHub #56: when the live ggml-org release lookup fails (most
  // commonly a 403 from the unauthenticated api.github.com 60/hr quota), the
  // resolver must fall back to a pinned offline floor instead of dead-ending,
  // and emit a distinct, zero-PII telemetry event.
  describe('fetchRemoteBackends offline floor (ATO-199)', () => {
    const OFFLINE_TAG = 'b9673'

    const makeResp = (overrides: {
      ok?: boolean
      status?: number
      rateLimitRemaining?: string | null
      json?: unknown
    }) =>
      ({
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        headers: {
          get: (key: string) =>
            key.toLowerCase() === 'x-ratelimit-remaining'
              ? (overrides.rateLimitRemaining ?? null)
              : null,
        },
        json: async () => overrides.json ?? {},
      }) as unknown as Response

    it('falls back to the pinned Windows floor on a 403 rate-limit', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [],
      } as any)
      vi.mocked(tauriFetch).mockResolvedValue(
        makeResp({ ok: false, status: 403, rateLimitRemaining: '0' })
      )

      const backends = await fetchRemoteBackends()
      const ids = backends.map((b) => b.backend).sort()
      expect(ids).toEqual(
        [
          'win-cpu-x64',
          'win-cuda-12.4-x64',
          'win-cuda-13.3-x64',
          'win-vulkan-x64',
        ].sort()
      )
      expect(backends.every((b) => b.version === OFFLINE_TAG)).toBe(true)

      // telemetry: classified as rate_limited, fallback used
      expect(tauriEmit).toHaveBeenCalledWith(
        'analytics://backend_resolve_failed',
        expect.objectContaining({
          reason: 'rate_limited',
          status: 403,
          os: 'windows',
          fallback_used: true,
        })
      )
    })

    it('returns the live release assets on success (no floor)', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [],
      } as any)
      vi.mocked(tauriFetch).mockResolvedValue(
        makeResp({
          ok: true,
          status: 200,
          json: {
            tag_name: 'b9999',
            assets: [
              { name: 'llama-b9999-bin-win-vulkan-x64.zip' },
              { name: 'llama-b9999-bin-win-cuda-13.4-x64.zip' },
              { name: 'llama-b9999-bin-win-hip-radeon-x64.zip' },
            ],
          },
        })
      )

      const backends = await fetchRemoteBackends()
      const ids = backends.map((b) => b.backend).sort()
      // hip-radeon is not whitelisted; cuda-13.4 + vulkan are surfaced
      expect(ids).toEqual(['win-cuda-13.4-x64', 'win-vulkan-x64'])
      expect(backends.every((b) => b.version === 'b9999')).toBe(true)
      expect(tauriEmit).not.toHaveBeenCalled()
    })

    it('falls back to the pinned Linux floor when the fetch throws (offline)', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [],
      } as any)
      vi.mocked(tauriFetch).mockRejectedValue(new Error('network unreachable'))

      const backends = await fetchRemoteBackends()
      const ids = backends.map((b) => b.backend).sort()
      expect(ids).toEqual(['linux-cpu-x64', 'linux-vulkan-x64'])
      expect(backends.every((b) => b.version === OFFLINE_TAG)).toBe(true)
      expect(tauriEmit).toHaveBeenCalledWith(
        'analytics://backend_resolve_failed',
        expect.objectContaining({ reason: 'offline', os: 'linux', fallback_used: true })
      )
    })

    it('falls back to the floor when a fetched release matched zero whitelisted assets', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [],
      } as any)
      vi.mocked(tauriFetch).mockResolvedValue(
        makeResp({
          ok: true,
          status: 200,
          json: { tag_name: 'b9999', assets: [{ name: 'unrelated.zip' }] },
        })
      )

      const backends = await fetchRemoteBackends()
      expect(backends.map((b) => b.backend)).toContain('win-vulkan-x64')
      expect(backends.every((b) => b.version === OFFLINE_TAG)).toBe(true)
      expect(tauriEmit).toHaveBeenCalledWith(
        'analytics://backend_resolve_failed',
        expect.objectContaining({ reason: 'asset_missing' })
      )
    })

    it('returns [] and emits nothing on macOS (bundled-only by design)', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'macos',
        cpu: { arch: 'arm64', extensions: [] },
        gpus: [],
      } as any)

      const backends = await fetchRemoteBackends()
      expect(backends).toEqual([])
      expect(tauriFetch).not.toHaveBeenCalled()
      expect(tauriEmit).not.toHaveBeenCalled()
    })

    it('the pinned floor resolves to an un-throttled github.com download URL', () => {
      expect(getBackendDownloadUrl(OFFLINE_TAG, 'win-vulkan-x64')).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${OFFLINE_TAG}/llama-${OFFLINE_TAG}-bin-win-vulkan-x64.zip`
      )
      expect(getBackendDownloadUrl(OFFLINE_TAG, 'linux-vulkan-x64')).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${OFFLINE_TAG}/llama-${OFFLINE_TAG}-bin-ubuntu-vulkan-x64.tar.gz`
      )
    })
  })
})
