import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { emitTransferProgress } from '@/services/diffusion/transfer'
import { strataCatalogRows } from '../catalog'
import {
  cancelStrata,
  installStrata,
  resumeStrata,
  strataTaskId,
} from '../install'
import fixture from './fixtures/catalog.json'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@/services/diffusion/transfer', () => ({
  downloadProxyConfig: () => undefined,
  emitTransferProgress: vi.fn(),
  emitTransferSuccess: vi.fn(),
  emitTransferError: vi.fn(),
}))

const descriptor = strataCatalogRows(fixture)[0].strata!
const plan = { descriptor, request_id: 'pinned', source_digest: 'a'.repeat(64) }
const job = {
  model_id: descriptor.variant_id,
  plan,
  state: 'files-ready',
  maintenance_id: null,
}
const operation = {
  ...plan,
  model_id: descriptor.variant_id,
  operation_id: 'operation',
  revision: 1,
  state: 'ready',
}

afterEach(() => vi.clearAllMocks())

describe('Strata preparation flow', () => {
  it('shares one operation and finishes only after core confirms preparation', async () => {
    const calls: string[] = []
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      calls.push(command === 'atomic_core_call' ? String(args?.path) : command)
      if (command === 'atomic_strata_acquire') return job
      if (args?.path === '/strata/preparations') return operation
      return undefined
    })
    const first = installStrata(descriptor)
    expect(installStrata(descriptor)).toBe(first)
    await first
    expect(calls).toEqual([
      'atomic_strata_acquire',
      '/strata/preparations',
      'atomic_strata_finish_install',
    ])
    expect(listen).toHaveBeenCalled()
  })

  it('uses the saved request and resumes interrupted preparation without a transfer', async () => {
    const calls: string[] = []
    let resumeBody: unknown
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      calls.push(command === 'atomic_core_call' ? String(args?.path) : command)
      if (command === 'atomic_strata_jobs')
        return [{ ...job, model_id: descriptor.variant_id }]
      if (args?.path === '/strata/preparations')
        return { ...operation, state: 'interrupted' }
      if (args?.path === '/strata/preparations/operation/resume') {
        resumeBody = args?.body
        return operation
      }
      return undefined
    })
    await resumeStrata(`strata-model-${descriptor.variant_id}`)
    // The saved files are reused: no acquisition, and no transfer progress
    // that would show a download bar for files already on disk.
    expect(calls).toEqual([
      'atomic_strata_jobs',
      '/strata/preparations',
      '/strata/preparations/operation/resume',
      'atomic_strata_finish_install',
    ])
    expect(resumeBody).toEqual({})
    expect(vi.mocked(emitTransferProgress).mock.calls).toEqual([])
  })

  it('retries cancellation if the native token is registered after the first request', async () => {
    let rejectTransfer!: (error: Error) => void
    let signalAcquiring!: () => void
    const acquiring = new Promise<void>((resolve) => {
      signalAcquiring = resolve
    })
    let cancels = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'atomic_strata_acquire') {
        signalAcquiring()
        return new Promise((_resolve, reject) => {
          rejectTransfer = reject
        })
      }
      if (command === 'cancel_download_task') {
        if (++cancels === 1) throw new Error('No download task yet')
        rejectTransfer(new Error('Cancelled'))
      }
      return undefined
    })
    const work = installStrata(descriptor)
    void work.catch(() => {})
    await acquiring
    await cancelStrata(strataTaskId(descriptor.variant_id))
    await expect(work).rejects.toThrow('Cancelled')
    expect(cancels).toBe(2)
    expect(invoke).not.toHaveBeenCalledWith(
      'atomic_core_call',
      expect.anything()
    )
  })
})
