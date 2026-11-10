import { beforeEach, expect, it, vi } from 'vitest'
import { restartChatJob } from '../job-controls'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { resumeDownload } from '@/lib/downloadResume'
import type { ServiceHub } from '@/services'
vi.mock('@/lib/downloadResume', () => ({ resumeDownload: vi.fn() }))
vi.mock('@/lib/downloadControls', () => ({ pauseDownload: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  useOnboardingStore.getState().reset()
  useDownloadStore.setState({ downloads: {}, resumeParams: {} })
})
it('review: Retry keeps the native-journal FLM job in the onboarding queue', () => {
  const job = {
    key: 'chat',
    kind: 'chat' as const,
    title: 'Qwen',
    taskId: 'fastflowlm-qwen',
    phase: 'failed' as const,
  }
  useOnboardingStore.getState().enqueue(job)
  restartChatJob(job, { serviceHub: {} as ServiceHub, t: (key) => key })
  expect(resumeDownload).toHaveBeenCalledTimes(1)
  expect(useOnboardingStore.getState().jobs).toEqual([
    expect.objectContaining({ key: 'chat', phase: 'running' }),
  ])
})
