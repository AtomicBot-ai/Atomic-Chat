import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Task 6.2 of move-sdcpp-mlx-install-to-core: the version on the MLX provider
// page is the active build in the core's catalog (`POST /engine-builds/mlx/catalog`),
// with where it came from, never a file in the app's resources.

const { emitMock, listenMock, eventsEmitMock, invokeMock, listeners } =
  vi.hoisted(() => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>()
    return {
      emitMock: vi.fn().mockResolvedValue(undefined),
      listenMock: vi.fn(
        async (
          name: string,
          handler: (event: { payload: unknown }) => void
        ) => {
          listeners.set(name, handler)
          return () => listeners.delete(name)
        }
      ),
      eventsEmitMock: vi.fn(),
      invokeMock: vi.fn(),
      listeners,
    }
  })

vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: listenMock,
}))

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  readGgufMetadata: vi.fn(),
}))

vi.mock('@janhq/core', () => ({
  AIEngine: class AIEngine {
    registerSettings(_: unknown) {}
    getSetting<T>(_: string, def: T) {
      return Promise.resolve(def)
    }
    async getSettings() {
      return []
    }
    async updateSettings(_: unknown) {}
    onLoad() {}
  },
  getJanDataFolderPath: vi.fn().mockResolvedValue('/tmp/jan'),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    fileStat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
  joinPath: vi.fn((parts: string[]) => Promise.resolve(parts.join('/'))),
  events: {
    emit: eventsEmitMock,
    on: vi.fn(),
    off: vi.fn(),
  },
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: {
    onFileDownloadStopped: 'onFileDownloadStopped',
  },
  ModelEvent: {
    OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen',
  },
  // Read at module load by `buildMlxConfig` / the ctx fallbacks, so a
  // factory mock without it throws before any test runs.
  DEFAULT_CTX_LEN: 16384,
  computeNextCtxLen: (current: number, max?: number) => {
    let next: number
    if (current < 8192) next = 8192
    else if (current < 32768) next = 32768
    else next = Math.round(current * 1.5)
    if (typeof max === 'number' && max > 0) next = Math.min(next, max)
    return next
  },
}))

import mlx_extension from './index'

const ACTIVE = {
  tag: 'mlxvlm-macos-arm64-abc1234',
  backend_id: 'macos-arm64',
  origin: 'downloaded',
  installed_at_ms: 1,
  published_at: '2026-10-01T00:00:00Z',
  removable: true,
  in_use: false,
  active: true,
}

function catalog(active: typeof ACTIVE | null) {
  return {
    engine: 'mlx',
    manifest: null,
    manifest_error: 'offline',
    host_backend_id: 'macos-arm64',
    host_reason: null,
    installed: active ? [active] : [],
    active,
  }
}

function core(answer: () => unknown) {
  const calls: string[] = []
  invokeMock.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'atomic_core_call') throw new Error(`plugin reached: ${command}`)
      calls.push(`${args?.['method']} ${args?.['path']}`)
      return answer()
    }
  )
  return calls
}

async function versionShown(ext: InstanceType<typeof mlx_extension>) {
  const updateSettings = vi.fn()
  const target = ext as unknown as {
    getSettings: () => Promise<unknown[]>
    updateSettings: typeof updateSettings
    detectBackendVersion: () => Promise<void>
  }
  target.getSettings = async () => [
    { key: 'version_backend', controllerProps: { value: 'detecting...' } },
  ]
  target.updateSettings = updateSettings
  await target.detectBackendVersion()
  return updateSettings.mock.calls.at(-1)?.[0]?.[0]?.controllerProps.value
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
})

describe('the MLX version on the provider page', () => {
  it('is the tag and origin of the build the core runs', async () => {
    const calls = core(() => catalog(ACTIVE))
    expect(await versionShown(new mlx_extension())).toBe(
      'mlxvlm-macos-arm64-abc1234/downloaded'
    )
    expect(calls).toEqual(['POST /engine-builds/mlx/catalog'])
  })

  it('names the installer when the bundled build is the active one', async () => {
    core(() => catalog({ ...ACTIVE, origin: 'bundled', installed_at_ms: null, removable: false } as never))
    expect(await versionShown(new mlx_extension())).toBe(
      'mlxvlm-macos-arm64-abc1234/bundled'
    )
  })

  it('says none when no build is installed', async () => {
    core(() => catalog(null))
    expect(await versionShown(new mlx_extension())).toBe('none')
  })
})

// Task 6.3: the core advises an MLX update (`POST /engine-builds/mlx/updates`), the extension
// turns it into the shared banner's offer, and the core's `engine-build:changed` refreshes the
// version once the build moved.
describe('MLX engine updates', () => {
  const NEWER = {
    update_needed: true,
    current: { tag: 'mlxvlm-macos-arm64-07ba5a1', backend_id: 'macos-arm64', origin: 'bundled' },
    target: {
      tag: 'mlxvlm-macos-arm64-abc1234',
      backend_id: 'macos-arm64',
      published_at: '2026-10-01T00:00:00Z',
      download_bytes: 210_000_000,
    },
  }
  const KEY = 'atomic_engine_update_offer_mlx'

  // This suite's jsdom has no storage; the offer lives in the webview's.
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('offers the build the core names as newer, on the shared banner', async () => {
    const calls = core(() => NEWER)
    const announced = vi.fn()
    window.addEventListener('app:engine-update-available', announced)
    const result = await new mlx_extension().checkForEngineUpdate({ force: true })
    window.removeEventListener('app:engine-update-available', announced)

    expect(calls).toEqual(['POST /engine-builds/mlx/updates'])
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ body: { force: true } })
    expect(result).toEqual({ updateAvailable: true, targetVersion: 'mlxvlm-macos-arm64-abc1234' })
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      provider: 'mlx',
      currentBackend: 'mlxvlm-macos-arm64-07ba5a1/macos-arm64',
      targetBackend: 'mlxvlm-macos-arm64-abc1234/macos-arm64',
      currentVersion: 'mlxvlm-macos-arm64-07ba5a1',
      targetVersion: 'mlxvlm-macos-arm64-abc1234',
      downloadSizeBytes: 210_000_000,
      restartRequired: false,
      releaseNotesUrl:
        'https://github.com/AtomicBot-ai/mlx-vlm/releases/tag/mlxvlm-macos-arm64-abc1234',
    })
    expect(announced).toHaveBeenCalledTimes(1)
  })

  it('offers nothing, and withdraws an old offer, when the core says no update is needed', async () => {
    localStorage.setItem(KEY, JSON.stringify({ provider: 'mlx' }))
    core(() => ({ ...NEWER, update_needed: false, target: null }))
    const retracted = vi.fn()
    window.addEventListener('app:engine-update-retracted', retracted)
    const result = await new mlx_extension().checkForEngineUpdate()
    window.removeEventListener('app:engine-update-retracted', retracted)

    expect(result).toEqual({ updateAvailable: false, targetVersion: null })
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ body: {} })
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(retracted).toHaveBeenCalledWith(expect.objectContaining({ detail: 'mlx' }))
  })

  it('checks on start and refreshes the version when the core changes the MLX build', async () => {
    // Defined by the bundler from settings.json; nothing here reads a setting.
    vi.stubGlobal('SETTINGS', [])
    const calls = core(() => NEWER)
    const ext = new mlx_extension()
    const detect = vi
      .spyOn(ext as unknown as { detectBackendVersion: () => Promise<void> }, 'detectBackendVersion')
      .mockResolvedValue()
    ;(ext as unknown as { listenForCoreSettings: () => Promise<void> }).listenForCoreSettings =
      async () => {}
    await ext.onLoad()
    await vi.waitFor(() => expect(calls).toContain('POST /engine-builds/mlx/updates'))
    expect(detect).toHaveBeenCalledTimes(1)

    listeners.get('atomic-core://engine-build:changed')?.({
      payload: { engine: 'sd-cpp', reason: 'install' },
    })
    expect(detect).toHaveBeenCalledTimes(1)
    listeners.get('atomic-core://engine-build:changed')?.({
      payload: { engine: 'mlx', reason: 'install' },
    })
    expect(detect).toHaveBeenCalledTimes(2)
  })
})
