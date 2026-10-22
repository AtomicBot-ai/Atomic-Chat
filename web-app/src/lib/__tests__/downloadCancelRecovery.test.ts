import { beforeEach, describe, expect, it } from 'vitest'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { modelDownloadKey, restoreDownloadRecovery, saveDownloadRecovery } from '@/lib/downloadRecovery'
import { beginLegacyDownloadRecovery, mergeLegacyModelDownloads } from '@/services/models/downloadRecovery'

const id = 'acme/model-Q4'
const params = {
  provider: 'llamacpp-upstream',
  modelPath: 'https://huggingface.co/acme/model/resolve/v1/model-Q4.gguf',
  hfToken: 'hf_test_secret',
}

describe('explicit model cancellation recovery', () => {
  beforeEach(() => {
    useDownloadStore.setState(useDownloadStore.getInitialState())
  })

  it('shares GGUF source identity across Prism and both llama.cpp providers', () => {
    const key = modelDownloadKey(params)
    expect(modelDownloadKey({ ...params, provider: 'atomic-prism' })).toBe(key)
    expect(modelDownloadKey({ ...params, provider: 'llamacpp' })).toBe(key)
    expect(modelDownloadKey({ ...params, modelPath: params.modelPath.replace('/v1/', '/v2/') })).not.toBe(key)
  })

  it('queues controls once in order without persisting pending user actions', () => {
    const state = useDownloadStore.getState()
    state.requestControl('cancel', { id, name: id })
    state.requestControl('cancel', { id, name: id })
    state.requestControl('resume', { id: 'org/next', name: 'org/next' })
    const requests = useDownloadStore.getState().controlRequests
    expect(requests.map((request) => request.action)).toEqual(['cancel', 'resume'])
    expect(state.takeControlRequest(requests[1].requestId)).toBe(false)
    expect(state.takeControlRequest(requests[0].requestId)).toBe(true)
    expect(state.takeControlRequest(requests[0].requestId)).toBe(false)
    expect(JSON.parse(localStorage.getItem('atomic-model-downloads-v1')!).state).toHaveProperty('recovery')
    expect(JSON.parse(localStorage.getItem('atomic-model-downloads-v1')!).state).not.toHaveProperty('controlRequests')
  })

  it('retires an installed Prism request using its shared GGUF directory', async () => {
    const modelId = 'org/installed'
    const state = useDownloadStore.getState()
    state.setResumeParams(modelId, { ...params, provider: 'atomic-prism' })
    state.updateProgress(modelId, 0.4, modelId, 40, 100)
    state.markPausedDownload(modelId)
    const checked: string[] = []
    await beginLegacyDownloadRecovery({
      app: () => ({ getJanDataFolder: async () => '/data' }),
      core: () => ({ async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command === 'readdir_sync') return [] as T
        const path = args?.args as string
        checked.push(path)
        return (path === '/data/llamacpp/models/org/installed/model.yml'
          ? { isDirectory: false, size: 100 }
          : path === '/data/llamacpp/models' || path === '/data/mlx/models'
            ? { isDirectory: true, size: 0 } : null) as T
      } }),
    })
    expect(checked).toContain('/data/llamacpp/models/org/installed/model.yml')
    expect(useDownloadStore.getState().downloads[modelId]).toBeUndefined()
    expect(useDownloadStore.getState().resumeParams[modelId]).toBeUndefined()
  })

  it('keeps Pause visible after reload but keeps Cancel hidden and its source reusable', () => {
    const store = useDownloadStore.getState()
    store.setResumeParams(id, params)
    store.updateProgress(id, 0.4, id, 40, 100)
    store.markPausedDownload(id)
    let restored = restoreDownloadRecovery(saveDownloadRecovery(useDownloadStore.getState()))
    expect(restored.downloads?.[id].current).toBe(40)
    expect(restored.pausedDownloads?.has(id)).toBe(true)

    store.dismissDownload(id)
    const saved = saveDownloadRecovery(useDownloadStore.getState())
    expect(JSON.stringify(saved)).not.toContain('hf_test_secret')
    restored = restoreDownloadRecovery(saved)
    expect(restored.downloads?.[id]).toBeUndefined()
    expect(restored.pausedDownloads?.has(id)).toBe(false)
    expect(restored.dismissedDownloads?.has(id)).toBe(true)
    expect(restored.resumeParams?.[id].modelPath).toBe(params.modelPath)
    useDownloadStore.setState(restored)
    mergeLegacyModelDownloads({ truncated: false, candidates: [{ id, params, current: 40, total: 100 }] })
    expect(useDownloadStore.getState().downloads[id]).toBeUndefined()
  })

  it('hides unresolved legacy rows across reload without forgetting untouched files', () => {
    useDownloadStore.getState().dismissDownload(id)
    useDownloadStore.setState(restoreDownloadRecovery(saveDownloadRecovery(useDownloadStore.getState())))
    mergeLegacyModelDownloads({ truncated: false, candidates: [{ id, current: 20, total: 0, blocked: 'missing_source' }] })
    expect(useDownloadStore.getState().downloads[id]).toBeUndefined()
    expect(useDownloadStore.getState().dismissedDownloads.has(id)).toBe(true)
  })

  it('ignores malformed cancellation records and late progress without recreating a row', () => {
    useDownloadStore.setState(restoreDownloadRecovery({ entries: [], dismissed: [null, '../outside', id] }))
    useDownloadStore.getState().updateProgress(id, 0.8, id, 80, 100)
    useDownloadStore.getState().updateStage(id, { kind: 'retrying', attempt: 1, maxAttempts: 5 })
    expect([...useDownloadStore.getState().dismissedDownloads]).toEqual([id])
    expect(useDownloadStore.getState().downloads[id]).toBeUndefined()
  })
})
