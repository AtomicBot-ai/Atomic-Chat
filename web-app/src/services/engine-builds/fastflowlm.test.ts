import { beforeEach, expect, it, vi } from 'vitest'
import { engineBuildCatalog } from './core'
import { installEngineBuildWithProgress } from './install'
import {
  installFastFlowLmEngine,
  useFastFlowLmEngineInstallStore,
} from './fastflowlm'
const mocks = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }))
vi.mock('./core', () => ({
  engineBuildCatalog: vi.fn(),
  engineBuildProxy: () => undefined,
}))
vi.mock('./install', () => ({
  engineBuildTaskId: (engine: string, tag: string) => `${engine}-${tag}`,
  installEngineBuildWithProgress: vi.fn(),
}))
vi.mock('@/stores/engine-versions-store', () => ({
  useEngineVersionsStore: { getState: () => ({ refresh: mocks.refresh }) },
}))
beforeEach(() => vi.clearAllMocks())
it('shares one verified FLM engine install and its progress between onboarding and the panel', async () => {
  vi.mocked(engineBuildCatalog).mockResolvedValue({
    manifest: { tag: 'flm-1.0.11-r2' },
    host_backend_id: 'linux-x64',
  } as never)
  let finish!: () => void
  vi.mocked(installEngineBuildWithProgress).mockImplementation(
    async (_engine, options) => {
      options.onProgress?.({ transferred: 5, total: 10 })
      return new Promise((resolve) => {
        finish = () => resolve({} as never)
      })
    }
  )
  const first = installFastFlowLmEngine()
  const second = installFastFlowLmEngine()
  expect(second).toBe(first)
  await vi.waitFor(() =>
    expect(installEngineBuildWithProgress).toHaveBeenCalledTimes(1)
  )
  expect(installEngineBuildWithProgress).toHaveBeenCalledWith(
    'fastflowlm',
    expect.objectContaining({ taskId: 'fastflowlm-flm-1.0.11-r2' })
  )
  expect(useFastFlowLmEngineInstallStore.getState()).toMatchObject({
    installing: true,
    progress: { transferred: 5, total: 10 },
  })
  finish()
  await first
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  expect(useFastFlowLmEngineInstallStore.getState()).toMatchObject({
    installing: false,
    progress: null,
  })
})
it('preserves catalog failures and allows a later explicit retry without starting a download', async () => {
  vi.mocked(engineBuildCatalog).mockResolvedValue({
    manifest: null,
    manifest_error: 'The signed FLM catalog is unavailable.',
  } as never)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(installFastFlowLmEngine()).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The signed FLM catalog is unavailable.',
    })
    expect(useFastFlowLmEngineInstallStore.getState().installing).toBe(false)
  }
  expect(engineBuildCatalog).toHaveBeenCalledTimes(2)
  expect(installEngineBuildWithProgress).not.toHaveBeenCalled()
})
