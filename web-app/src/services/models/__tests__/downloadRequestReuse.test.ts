import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { DefaultModelsService, deferActiveModelDownloadCompletion } from '../default'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { restoreDownloadRecovery, saveDownloadRecovery } from '@/lib/downloadRecovery'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
const URL = 'https://huggingface.co/org/model/resolve/v1/model-Q4-00001-of-00003.gguf'
const deferred: (() => void)[] = []
function pending() {
  return new Promise<undefined>((resolve) => deferred.push(() => resolve(undefined)))
}
beforeEach(() => useDownloadStore.setState(useDownloadStore.getInitialState()))
afterEach(async () => {
  deferred.splice(0).forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
  vi.restoreAllMocks()
})

describe('shared model request lifecycle', () => {
  it('repairs lost progress/source/activity without another import and releases the row only when the import settles', async () => {
    const service = new DefaultModelsService()
    const start = vi.spyOn(service as never, 'startModelDownload').mockImplementation(pending)
    const first = service.pullModelWithMetadata('org/original', URL)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const state = useDownloadStore.getState()
    state.setResumeParams('org/original', { modelPath: URL, provider: 'llamacpp-upstream' })
    state.updateProgress('org/original', 0.4, 'org/original', 40, 100)
    const completed = vi.fn()
    expect(deferActiveModelDownloadCompletion('org/original', completed)).toBe(true)
    expect(completed).not.toHaveBeenCalled()
    state.removeDownload('org/original')
    state.removeLocalDownloadingModel('org/original')
    state.clearResumeParams('org/original')
    expect(useDownloadStore.getState().downloads['org/original']).toMatchObject({ current: 40, total: 100, progress: 0.4 })
    expect(useDownloadStore.getState().resumeParams['org/original']?.modelPath).toBe(URL)
    expect(useDownloadStore.getState().localDownloadingModels.has('org/original')).toBe(true)
    const retry = service.pullModelWithMetadata('org/alias', URL)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(start).toHaveBeenCalledTimes(1)
    expect(Object.keys(useDownloadStore.getState().downloads)).toEqual(['org/original'])
    deferred.splice(0).forEach((resolve) => resolve())
    await Promise.all([first, retry])
    expect(completed).toHaveBeenCalledTimes(1)
    expect(useDownloadStore.getState().downloads).toEqual({})
    expect(useDownloadStore.getState().localDownloadingModels.size).toBe(0)
    expect(useDownloadStore.getState().resumeParams).toEqual({})
  })

  it('preserves a paused row but never repairs an explicitly dismissed job', async () => {
    const service = new DefaultModelsService()
    vi.spyOn(service as never, 'startModelDownload').mockImplementation(pending)
    const operation = service.pullModelWithMetadata('org/paused', URL)
    await waitFor(() => expect(useDownloadStore.getState().localDownloadingModels.has('org/paused')).toBe(true))
    const state = useDownloadStore.getState()
    state.setResumeParams('org/paused', { modelPath: URL })
    state.updateProgress('org/paused', 0.4, 'org/paused', 40, 100)
    const completed = vi.fn()
    expect(deferActiveModelDownloadCompletion('org/paused', completed)).toBe(true)
    state.markPausedDownload('org/paused')
    state.removeLocalDownloadingModel('org/paused')
    state.removeDownload('org/paused')
    expect(useDownloadStore.getState().downloads['org/paused']?.current).toBe(40)
    expect(useDownloadStore.getState().localDownloadingModels.has('org/paused')).toBe(false)
    state.dismissDownload('org/paused')
    state.clearResumeParams('org/paused')
    expect(useDownloadStore.getState().downloads).toEqual({})
    deferred.splice(0).forEach((resolve) => resolve())
    await operation
    expect(completed).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().downloads).toEqual({})
    expect(useDownloadStore.getState().dismissedDownloads.has('org/paused')).toBe(true)
  })

  it('coalesces simultaneous shard aliases across the shared GGUF providers', async () => {
    const service = new DefaultModelsService()
    // Hold the physical import pending; exercise the public request coordinator.
    const start = vi.spyOn(service as never, 'startModelDownload').mockImplementation(pending)
    const first = service.pullModelWithMetadata('org/first', URL, undefined, undefined, true, false, { provider: 'llamacpp-upstream' })
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const second = service.pullModelWithMetadata('org/alias', URL.replace('00001-of', '00002-of'), undefined, undefined, true, false, { provider: 'atomic-prism' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(start).toHaveBeenCalledTimes(1)
    expect(useDownloadStore.getState().localDownloadingModels.has('org/alias')).toBe(false)
    deferred.splice(0).forEach((resolve) => resolve())
    await Promise.all([first, second])
  })

  it('reuses the restored destination with resume enabled', async () => {
    const state = useDownloadStore.getState()
    state.setResumeParams('org/original', { provider: 'llamacpp-upstream', modelPath: URL })
    state.updateProgress('org/original', 0.4, 'org/original', 40, 100)
    useDownloadStore.setState(restoreDownloadRecovery(saveDownloadRecovery(useDownloadStore.getState())))
    const service = new DefaultModelsService()
    const start = vi.spyOn(service as never, 'startModelDownload').mockResolvedValue(undefined)
    await service.pullModelWithMetadata('org/new-id', URL, undefined, undefined, true, false, { provider: 'llamacpp' })
    expect(start).toHaveBeenCalledWith('org/original', URL, undefined, undefined, true, true, { provider: 'llamacpp' })
    expect(useDownloadStore.getState().localDownloadingModels.has('org/new-id')).toBe(false)
  })

  it('refuses a different revision targeting a destination whose import is active', async () => {
    const service = new DefaultModelsService()
    const start = vi.spyOn(service as never, 'startModelDownload').mockImplementation(pending)
    const first = service.pullModelWithMetadata('org/same', URL)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const refusal = await service.pullModelWithMetadata('org/same', URL.replace('/v1/', '/v2/'))
    expect(refusal).toMatchObject({ kind: 'destination_busy', modelId: 'org/same' })
    expect(start).toHaveBeenCalledTimes(1)
    deferred.splice(0).forEach((resolve) => resolve())
    await first
  })
})
