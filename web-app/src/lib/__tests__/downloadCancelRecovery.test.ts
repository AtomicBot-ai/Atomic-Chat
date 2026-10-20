import { beforeEach, describe, expect, it } from 'vitest'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { restoreDownloadRecovery, saveDownloadRecovery } from '@/lib/downloadRecovery'
import { mergeLegacyModelDownloads } from '@/services/models/downloadRecovery'

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
