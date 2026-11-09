import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useFastFlowLmSync } from '../useFastFlowLmSync'
import {
  fastFlowLmInstallJobs,
  resumeFastFlowLmDownload,
} from '@/services/fastflowlm/install'
import { useModelProvider } from '@/hooks/useModelProvider'
import { restoreInterruptedDownloads } from '@/lib/interrupted-downloads'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  providers: vi.fn(async () => []),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@/services/fastflowlm/install', () => ({
  fastFlowLmInstallJobs: vi.fn(),
  resumeFastFlowLmDownload: vi.fn(async () => {}),
  fastFlowLmDownloadId: (id: string) => `fastflowlm-${id}`,
}))
vi.mock('@/lib/interrupted-downloads', () => ({
  restoreInterruptedDownloads: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
const hub = {
  providers: () => ({ getProviders: mocks.providers }),
  events: () => ({
    listen: async (event: string, handler: () => void) => {
      mocks.handlers.set(event, handler)
      return () => mocks.handlers.delete(event)
    },
  }),
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  useModelProvider.setState({
    providers: [{ provider: 'fastflowlm', models: [] }] as ModelProvider[],
  })
})
it('restores an interrupted transfer as paused without starting another download', async () => {
  vi.mocked(fastFlowLmInstallJobs).mockResolvedValue([
    {
      model_id: 'qwen',
      state: 'downloading',
      plan: { name: 'Qwen', total_bytes: 100 },
    },
  ] as never)
  renderHook(() => useFastFlowLmSync())
  await waitFor(() =>
    expect(restoreInterruptedDownloads).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'fastflowlm-qwen', total: 100 }),
    ])
  )
  expect(invoke).toHaveBeenCalledWith('atomic_fastflowlm_recover_mutations')
  expect(resumeFastFlowLmDownload).not.toHaveBeenCalled()
})
it('shares snapshot recovery while the original publication is still in flight', async () => {
  vi.mocked(fastFlowLmInstallJobs).mockResolvedValue([
    {
      model_id: 'qwen',
      state: 'publishing',
      plan: { name: 'Qwen', total_bytes: 100 },
    },
  ] as never)
  let release!: () => void
  vi.mocked(resumeFastFlowLmDownload).mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  renderHook(() => useFastFlowLmSync())
  await waitFor(() => expect(resumeFastFlowLmDownload).toHaveBeenCalledTimes(1))
  mocks.handlers.get('atomic-core://snapshot')?.()
  mocks.handlers.get('atomic-core://snapshot')?.()
  expect(resumeFastFlowLmDownload).toHaveBeenCalledTimes(1)
  release()
  await waitFor(() => expect(mocks.providers).toHaveBeenCalledTimes(1))
})
