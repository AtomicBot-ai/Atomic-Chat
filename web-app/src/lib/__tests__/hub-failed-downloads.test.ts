import { beforeEach, describe, expect, it } from 'vitest'
import { failedDownloadModels } from '../hub-failed-downloads'
import {
  RECENT_FAILURE_WINDOW,
  useFailedDownloadsStore,
} from '@/stores/failed-downloads-store'
import type { CatalogModel } from '@/services/models/types'

beforeEach(() => {
  useFailedDownloadsStore.setState({ failures: [] })
  localStorage.clear()
})
describe('recent failed download recovery', () => {
  it('retains only bounded recent failures, replaces retries and removes success', () => {
    const now = Date.now()
    for (let i = 0; i < 25; i++)
      useFailedDownloadsStore
        .getState()
        .record(`model-${i}`, `owner/model-${i}`, false)
    expect(useFailedDownloadsStore.getState().failures).toHaveLength(20)
    useFailedDownloadsStore
      .getState()
      .record('model-24', 'owner/model-24', false)
    expect(
      useFailedDownloadsStore
        .getState()
        .failures.filter((entry) => entry.modelId === 'model-24')
    ).toHaveLength(1)
    const old = {
      modelId: 'old',
      repo: 'owner/old',
      isMlx: false,
      failedAt: now - RECENT_FAILURE_WINDOW,
    }
    expect(failedDownloadModels([old], [], new Map(), '', now)).toEqual([])
    useFailedDownloadsStore.getState().clear('model-24')
    expect(
      useFailedDownloadsStore
        .getState()
        .failures.some((entry) => entry.modelId === 'model-24')
    ).toBe(false)
  })
  it('persists credential-free metadata and restores it on rehydrate', async () => {
    useFailedDownloadsStore.getState().record('q4', 'owner/chat-GGUF', false)
    const persisted = localStorage.getItem('atomic-recent-failed-downloads')!
    expect(Object.keys(JSON.parse(persisted).state.failures[0]).sort()).toEqual(
      ['failedAt', 'isMlx', 'modelId', 'repo']
    )
    useFailedDownloadsStore.setState({ failures: [] })
    localStorage.setItem('atomic-recent-failed-downloads', persisted)
    await useFailedDownloadsStore.persist.rehydrate()
    expect(useFailedDownloadsStore.getState().failures[0].repo).toBe(
      'owner/chat-GGUF'
    )
  })
  it.each([
    'https://huggingface.co/owner/model?token=secret',
    '/Users/example/private',
    'owner/model/resolve/main',
    'owner/model?token=secret',
  ])('rejects non-repository metadata %s', (repo) => {
    useFailedDownloadsStore.getState().record('q4', repo, false)
    expect(useFailedDownloadsStore.getState().failures).toEqual([])
  })
  it('keeps a failed managed checkpoint downloadable after noncatalog enrichment', () => {
    const now = Date.now()
    const failures = [
      {
        modelId: 'managed-owner_chat',
        repo: 'owner/chat',
        isMlx: false,
        failedAt: now,
      },
    ]
    const detail = {
      model_name: 'owner/chat',
      description: '',
      downloads: 1,
      is_mlx: false,
      quants: [],
      safetensors_files: [
        {
          model_id: 'model',
          path: 'https://huggingface.co/owner/chat/resolve/main/model.safetensors',
          file_size: '5GB',
        },
      ],
    } satisfies CatalogModel
    expect(
      failedDownloadModels(failures, [], new Map(), '', now)[0].is_managed
    ).toBe(true)
    expect(
      failedDownloadModels(
        failures,
        [],
        new Map([['owner/chat', detail]]),
        '',
        now
      )[0].is_managed
    ).toBe(true)
  })

  it('returns a failed noncatalog repo, deduplicates quants, searches and enriches its card', () => {
    const now = Date.now()
    const failures = ['q4', 'q8'].map((modelId) => ({
      modelId,
      repo: 'owner/chat-GGUF',
      isMlx: false,
      failedAt: now,
    }))
    expect(failedDownloadModels(failures, [], new Map(), '', now)).toEqual([
      {
        model_name: 'owner/chat-GGUF',
        description: '',
        downloads: 0,
        is_mlx: false,
      },
    ])
    expect(failedDownloadModels(failures, [], new Map(), 'other', now)).toEqual(
      []
    )
    const detail = {
      model_name: failures[0].repo,
      description: 'ready',
      downloads: 5,
      quants: [
        {
          model_id: 'q4',
          path: 'owner/chat-GGUF/resolve/main/q4.gguf',
          file_size: '5GB',
        },
      ],
    } satisfies CatalogModel
    expect(
      failedDownloadModels(
        failures,
        [],
        new Map([[detail.model_name, detail]]),
        'CHAT',
        now
      )
    ).toEqual([detail])
  })
})
