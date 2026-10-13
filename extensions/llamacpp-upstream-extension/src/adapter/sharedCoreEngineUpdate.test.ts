import { describe, expect, it, vi } from 'vitest'

import {
  engineUpdateTaskId,
  updateEngineThroughCore,
} from '../../../shared/coreEngineUpdate'

/** A relay the test drives: one `download-<task_id>` listener at a time. */
function relay() {
  let handler: ((event: { payload: unknown }) => void) | undefined
  const unlisten = vi.fn()
  return {
    listen: vi.fn(async (_name: string, h: (event: { payload: unknown }) => void) => {
      handler = h
      return unlisten
    }),
    frame: (payload: unknown) => handler?.({ payload }),
    unlisten,
  }
}

const UPDATED = {
  updated: true,
  active: { version: 'b11500', variant: 'win-vulkan-x64' },
  retired: [],
  kept_in_use: [],
}

describe('updateEngineThroughCore', () => {
  it('names the task the way the desktop routes its Cancel to the core', () => {
    expect(engineUpdateTaskId('llamacpp-upstream', 'latest/win-cuda-13.3-x64')).toBe(
      'engine-update-llamacpp-upstream-latest_win-cuda-13_3-x64'
    )
  })

  it('asks the core to update, shows the download, then announces the switch', async () => {
    const r = relay()
    const emitted: [string, unknown][] = []
    const dispatched: CustomEvent[] = []
    const updateEngine = vi.fn(async () => {
      r.frame({ transferred: 50, total: 100 })
      r.frame({ transferred: 100, total: 100 })
      return UPDATED
    })

    const result = await updateEngineThroughCore({
      core: { updateEngine },
      provider: 'llamacpp-upstream',
      backend: 'latest/win-vulkan-x64',
      target: { variant: 'win-vulkan-x64' },
      proxy: null,
      listen: r.listen,
      emit: (name, payload) => emitted.push([name, payload]),
      dispatch: (event) => dispatched.push(event),
    })

    expect(result).toEqual(UPDATED)
    const taskId = 'engine-update-llamacpp-upstream-latest_win-vulkan-x64'
    expect(updateEngine).toHaveBeenCalledWith({
      task_id: taskId,
      target: { variant: 'win-vulkan-x64' },
    })
    expect(r.listen).toHaveBeenCalledWith(`download-${taskId}`, expect.any(Function))
    expect(emitted.map(([name]) => name)).toEqual([
      'onBackendDownloadStarted',
      'onFileDownloadUpdate',
      'onFileDownloadUpdate',
      'onFileDownloadAndVerificationSuccess',
      'onBackendDownloadFinished',
    ])
    expect(emitted.at(-1)?.[1]).toMatchObject({
      backend: 'latest/win-vulkan-x64',
      status: 'completed',
      provider: 'llamacpp-upstream',
    })
    expect(dispatched.map((e) => [e.type, e.detail])).toEqual([
      [
        'app:backend-hotswapped',
        {
          backend: 'b11500/win-vulkan-x64',
          provider: 'llamacpp-upstream',
          version: 'b11500',
          backendId: 'win-vulkan-x64',
        },
      ],
    ])
    expect(r.unlisten).toHaveBeenCalled()
  })

  it('reports a failure and switches nothing', async () => {
    const r = relay()
    const emitted: [string, unknown][] = []
    const dispatched: CustomEvent[] = []

    await expect(
      updateEngineThroughCore({
        core: {
          updateEngine: vi.fn(async () => {
            throw { code: 'ENGINE_INSTALL_FAILED', message: 'download failed' }
          }),
        },
        provider: 'llamacpp',
        backend: 'b10018-1.3.0/linux-x64-rocm',
        target: { version: 'b10018-1.3.0', variant: 'linux-x64-rocm' },
        proxy: null,
        listen: r.listen,
        emit: (name, payload) => emitted.push([name, payload]),
        dispatch: (event) => dispatched.push(event),
      })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' })

    expect(emitted.map(([name]) => name)).toEqual([
      'onBackendDownloadStarted',
      'onFileDownloadError',
      'onBackendDownloadFinished',
    ])
    expect(emitted.at(-1)?.[1]).toMatchObject({
      status: 'failed',
      error: 'download failed [ENGINE_INSTALL_FAILED]',
    })
    expect(dispatched).toEqual([])
    expect(r.unlisten).toHaveBeenCalled()
  })
})
