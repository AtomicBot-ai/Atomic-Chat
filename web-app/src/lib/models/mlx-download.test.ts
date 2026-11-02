import { beforeEach, expect, it, vi } from 'vitest'
import {
  cancelAtomicModelPreparation,
  readAtomicDownloadPlan,
} from '@janhq/core'
import type { ModelsService } from '@/services/models/types'
import { mlxDownloadOptions } from './mlx-download'
import { preflightDownloadDiskSpace } from '@/services/models/downloadPreflight'

vi.mock('@/services/models/downloadPreflight', () => ({
  preflightDownloadDiskSpace: vi.fn().mockResolvedValue(undefined),
}))

const revision = 'a'.repeat(40)
const metadata = {
  sha: revision,
  siblings: [
    { rfilename: 'model-00001-of-00002.safetensors', size: 4 },
    { rfilename: 'model-00002-of-00002.safetensors', size: 6 },
    { rfilename: 'config.json', size: 2 },
    { rfilename: 'tokenizer.json', size: 3 },
  ],
}
beforeEach(() => {
  localStorage.clear()
  vi.mocked(preflightDownloadDiskSpace).mockReset().mockResolvedValue(undefined)
})

it('persists all MLX files and resumes the same tree without reaching HF', async () => {
  const fetchHuggingFaceRepo = vi.fn().mockResolvedValue(metadata)
  const service = { fetchHuggingFaceRepo } as unknown as ModelsService
  const first = await mlxDownloadOptions(
    service,
    'model',
    'o/r',
    false,
    'secret'
  )
  expect(first.files).toHaveLength(3)
  expect(
    first.files.every((file) => file.url.includes(`/resolve/${revision}/`))
  ).toBe(true)
  expect(readAtomicDownloadPlan('request:mlx/model')?.files).toHaveLength(4)
  expect(
    localStorage.getItem('atomic_model_download_plan_v1:request:mlx/model')
  ).not.toContain('secret')
  fetchHuggingFaceRepo.mockRejectedValue(new Error('offline'))
  expect(await mlxDownloadOptions(service, 'model', 'o/changed', true)).toEqual(
    { ...first, resume: true }
  )
  expect(fetchHuggingFaceRepo).toHaveBeenCalledTimes(1)
})

it('rejects an older MLX task without deleting its data or requesting metadata', async () => {
  localStorage.setItem('old-state', 'kept')
  const fetchHuggingFaceRepo = vi.fn()
  await expect(
    mlxDownloadOptions(
      { fetchHuggingFaceRepo } as unknown as ModelsService,
      'old',
      'o/r',
      true
    )
  ).rejects.toThrow('no recorded model plan')
  expect(fetchHuggingFaceRepo).not.toHaveBeenCalled()
  expect(localStorage.getItem('old-state')).toBe('kept')
})

it('does not save or start a request cancelled while metadata is being read', async () => {
  let reply!: (data: unknown) => void
  const service = {
    fetchHuggingFaceRepo: () =>
      new Promise((resolve) => {
        reply = resolve
      }),
  } as unknown as ModelsService
  const pending = mlxDownloadOptions(service, 'model', 'o/r', false)
  cancelAtomicModelPreparation('mlx/model')
  reply(metadata)
  await expect(pending).rejects.toThrow()
  expect(readAtomicDownloadPlan('request:mlx/model')).toBeUndefined()
})

it('checks the entire MLX tree size before saving a new request', async () => {
  vi.mocked(preflightDownloadDiskSpace).mockResolvedValue({
    kind: 'disk_full',
    needed: 25,
    available: 10,
  })
  const service = {
    fetchHuggingFaceRepo: vi.fn().mockResolvedValue(metadata),
  } as unknown as ModelsService
  await expect(
    mlxDownloadOptions(service, 'full', 'o/r', false)
  ).rejects.toThrow('Not enough disk space')
  expect(preflightDownloadDiskSpace).toHaveBeenCalledWith({
    modelPath: `https://huggingface.co/o/r/resolve/${revision}/model-00001-of-00002.safetensors`,
    modelSize: 15,
  })
  expect(readAtomicDownloadPlan('request:mlx/full')).toBeUndefined()
})

it('does not persist a tree that has no model weights', async () => {
  const service = {
    fetchHuggingFaceRepo: vi.fn().mockResolvedValue({
      ...metadata,
      siblings: [{ rfilename: 'config.json', size: 2 }],
    }),
  } as unknown as ModelsService
  await expect(
    mlxDownloadOptions(service, 'invalid', 'o/r', false)
  ).rejects.toThrow('No safetensors')
  expect(preflightDownloadDiskSpace).not.toHaveBeenCalled()
  expect(readAtomicDownloadPlan('request:mlx/invalid')).toBeUndefined()
})
