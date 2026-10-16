import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import { transferFiles, type TransferItem } from '../transfer'

describe('transferFiles', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    ;(window as unknown as { core?: unknown }).core = undefined
  })

  it('sends each item to the Rust downloader with its resume_key', async () => {
    const item: TransferItem = {
      url: 'https://acct.blob.core.windows.net/c/v5/model.onnx?sig=fresh',
      save_path: '/data/foundry-local/models/v/model.onnx',
      size: 6,
      model_id: 'foundry-local-v',
      resume_key: 'foundry-local/v/model.onnx',
    }

    await transferFiles([item], 'foundry-local-v', { resume: true })

    // What the Rust command receives: the item exactly as given, key included.
    const sent = invoke.mock.calls.find(([command]) => command === 'download_files')?.[1]
    expect(sent).toEqual({
      items: [item],
      taskId: 'foundry-local-v',
      headers: {},
      resume: true,
    })
  })
})
